import { spawnSync } from "node:child_process";
import { createRemoteCodexStarter } from "./remote-codex-adapter.js";
import { loadRemoteWorkerConfig } from "./remote-worker-config.js";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  type RemoteWorkerPlatform,
  type ServerToWorkerMessage,
  type WorkerToServerMessage,
} from "./remote-worker-protocol.js";
import { RemoteWorkerRuntime } from "./remote-worker-runtime.js";

function workerPlatform(): RemoteWorkerPlatform {
  if (process.platform === "linux" || process.platform === "darwin" || process.platform === "win32") return process.platform;
  throw new Error(`Unsupported remote worker platform: ${process.platform}`);
}

function codexVersion(executablePath?: string): string | undefined {
  const result = spawnSync(executablePath || "codex", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || result.stderr.trim() || undefined;
}

function endpoint(serverUrl: string, path: string): string {
  return `${serverUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function authHeaders(token: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function responseError(response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = await response.json() as { error?: unknown };
    detail = typeof body.error === "string" ? body.error : "";
  } catch { /* Ignore non-JSON gateway responses. */ }
  return new Error(detail || `Remote worker server returned HTTP ${response.status}`);
}

async function register(serverUrl: string, token: string, hello: unknown): Promise<string> {
  const response = await fetch(endpoint(serverUrl, "/register"), {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(hello),
  });
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as { sessionId?: unknown };
  if (typeof body.sessionId !== "string" || !body.sessionId) throw new Error("Remote worker server returned an invalid session id");
  return body.sessionId;
}

async function poll(serverUrl: string, token: string, sessionId: string, signal: AbortSignal): Promise<ServerToWorkerMessage | null> {
  const response = await fetch(endpoint(serverUrl, `/poll/${encodeURIComponent(sessionId)}`), {
    method: "GET",
    headers: authHeaders(token),
    signal,
  });
  if (response.status === 204) return null;
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as { message?: unknown };
  if (!body.message || typeof body.message !== "object") throw new Error("Remote worker server returned an invalid poll payload");
  return body.message as ServerToWorkerMessage;
}

async function postMessage(serverUrl: string, token: string, sessionId: string, message: WorkerToServerMessage): Promise<void> {
  const response = await fetch(endpoint(serverUrl, `/message/${encodeURIComponent(sessionId)}`), {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(message),
  });
  if (!response.ok) throw await responseError(response);
}

async function closeSession(serverUrl: string, token: string, sessionId: string): Promise<void> {
  try {
    await fetch(endpoint(serverUrl, `/session/${encodeURIComponent(sessionId)}`), {
      method: "DELETE",
      headers: authHeaders(token),
    });
  } catch { /* Best effort during reconnect/shutdown. */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const token = process.env.REMOTE_WORKER_TOKEN ?? "";
  if (token.length < 32) throw new Error("REMOTE_WORKER_TOKEN must contain at least 32 characters");
  const configPath = process.argv[2] || process.env.REMOTE_WORKER_CONFIG || "remote-worker.json";
  const config = loadRemoteWorkerConfig(configPath);
  const runtime = new RemoteWorkerRuntime(config.projects, createRemoteCodexStarter({
    ...(config.codexExecutablePath ? { executablePath: config.codexExecutablePath } : {}),
    defaultModel: config.defaultModel,
    defaultReasoningEffort: config.defaultReasoningEffort,
  }));
  const hello = {
    type: "worker.hello" as const,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId: config.workerId,
    displayName: config.displayName,
    capabilities: {
      platform: workerPlatform(),
      arch: process.arch,
      codexVersion: codexVersion(config.codexExecutablePath),
      supportsSteering: true,
      supportsInterrupt: true,
      supportsAttachments: true,
    },
    projects: config.projects.map((project) => ({ id: project.id, name: project.name })),
  };

  let stopping = false;
  let activePoll: AbortController | undefined;
  const handlers = new Set<Promise<void>>();
  const outbound = new Set<Promise<void>>();
  const requestStop = () => {
    stopping = true;
    runtime.shutdown();
    activePoll?.abort();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  while (!stopping) {
    let sessionId = "";
    try {
      sessionId = await register(config.serverUrl, token, hello);
      console.log(`Remote worker ${config.workerId} connected with ${config.projects.length} project(s).`);
      while (!stopping) {
        activePoll = new AbortController();
        const message = await poll(config.serverUrl, token, sessionId, activePoll.signal);
        activePoll = undefined;
        if (!message) continue;
        const task = runtime.handle(message, (workerMessage) => {
          const send = postMessage(config.serverUrl, token, sessionId, workerMessage)
            .catch((error) => console.error(`Unable to publish remote worker event: ${error instanceof Error ? error.message : String(error)}`));
          outbound.add(send);
          void send.finally(() => outbound.delete(send));
        }).catch((error) => {
          console.error(`Unable to handle remote worker message: ${error instanceof Error ? error.message : String(error)}`);
        });
        handlers.add(task);
        void task.finally(() => handlers.delete(task));
      }
    } catch (error) {
      activePoll = undefined;
      if (!stopping) {
        runtime.shutdown();
        console.error(`Remote worker connection lost: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (sessionId) await closeSession(config.serverUrl, token, sessionId);
    }
    if (!stopping) await sleep(2_000);
  }

  runtime.shutdown();
  await Promise.allSettled([...handlers, ...outbound]);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
