import fs from "node:fs";
import path from "node:path";
import {
  startAppServerTurn,
  type AppServerTurnExecution,
  type AppServerTurnOptions,
} from "./app-server-turn.js";
import { DEFAULT_OPTIONAL_AGENT_CAPABILITIES } from "./optional-capabilities.js";
import type { RemoteCodexStarter } from "./remote-worker-runtime.js";

export type RemoteCodexAdapterConfig = {
  executablePath?: string;
  defaultModel: string;
  defaultReasoningEffort: string;
  networkAccessEnabled?: boolean;
  webSearchMode?: "cached" | "live";
  sandbox?: "workspace-write" | "danger-full-access";
};

export type RemoteAppServerCallbacks = {
  signal: AbortSignal;
  onThreadStarted(threadId: string): void;
  onProgress(payload: unknown): void;
};

export type RemoteAppServerStarter = (
  options: AppServerTurnOptions,
  callbacks: RemoteAppServerCallbacks,
) => AppServerTurnExecution;

const SAFE_REMOTE_ENVIRONMENT_KEYS = new Set([
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "SHELL",
  "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "USER", "LOGNAME",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "FORCE_COLOR", "CODEX_HOME", "CWW_REMOTE_JOB_ROOT",
]);

/**
 * Adapter used by a trusted remote worker. It intentionally keeps the worker
 * process' existing HOME and only overrides CODEX_HOME when the locally
 * registered project asks for it. The server never supplies cwd/CODEX_HOME.
 */
export function createRemoteCodexStarter(
  config: RemoteCodexAdapterConfig,
  startTurn: RemoteAppServerStarter = startAppServerTurn,
): RemoteCodexStarter {
  if (!config.defaultModel.trim()) throw new Error("Remote worker default model is required");
  if (!config.defaultReasoningEffort.trim()) throw new Error("Remote worker default reasoning effort is required");

  return (input, callbacks) => {
    const stat = fs.statSync(input.cwd, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) throw new Error("Registered remote project directory is unavailable");

    if (input.codexHome) {
      const codexHomeStat = fs.statSync(input.codexHome, { throwIfNoEntry: false });
      if (!codexHomeStat?.isDirectory()) throw new Error("Registered remote CODEX_HOME is unavailable");
    }

    const runtimeRoot = input.runtimeRoot ? path.resolve(input.runtimeRoot) : undefined;
    if (runtimeRoot) {
      const runtimeStat = fs.statSync(runtimeRoot, { throwIfNoEntry: false });
      if (!runtimeStat?.isDirectory()) throw new Error("Remote attachment runtime is unavailable");
    }
    const imagePaths = (input.imagePaths ?? []).map((imagePath) => {
      if (!runtimeRoot) throw new Error("Remote image attachment requires a staged runtime directory");
      const resolved = path.resolve(imagePath);
      if (resolved !== runtimeRoot && !resolved.startsWith(`${runtimeRoot}${path.sep}`)) {
        throw new Error("Remote image path escapes the staged runtime directory");
      }
      const imageStat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (!imageStat?.isFile()) throw new Error("Remote image attachment is unavailable");
      return resolved;
    });

    const controller = new AbortController();
    const env = buildRemoteCodexEnvironment(process.env);
    if (input.codexHome) env.CODEX_HOME = input.codexHome;
    if (runtimeRoot) env.CWW_REMOTE_JOB_ROOT = runtimeRoot;
    const shellEnvironment = buildRemoteCodexEnvironment(env);
    const runtimeWorkspaceRoots = runtimeRoot ? [input.cwd, runtimeRoot] : [input.cwd];

    let execution: AppServerTurnExecution;
    try {
      execution = startTurn({
        executablePath: config.executablePath ?? "codex",
        cwd: input.cwd,
        env,
        threadId: input.threadId ?? null,
        prompt: input.prompt,
        imagePaths,
        model: input.model ?? config.defaultModel,
        reasoningEffort: input.reasoningEffort ?? config.defaultReasoningEffort,
        library: runtimeRoot ?? input.cwd,
        shellEnvironment,
        networkAccessEnabled: config.networkAccessEnabled ?? true,
        webSearchMode: config.webSearchMode ?? "live",
        sandbox: config.sandbox ?? "workspace-write",
        runtimeWorkspaceRoots,
        optionalCapabilities: { ...DEFAULT_OPTIONAL_AGENT_CAPABILITIES },
      }, {
        signal: controller.signal,
        onThreadStarted: callbacks.onThreadStarted,
        onProgress: callbacks.onProgress,
      });
    } catch {
      throw new Error("Unable to start the local Codex app-server");
    }
    const result = execution.result.catch((error: unknown) => {
      const cancelled = error instanceof Error && error.name === "AbortError";
      const safe = new Error(cancelled ? "Remote Codex task was cancelled" : "Remote Codex app-server failed");
      if (cancelled) safe.name = "AbortError";
      throw safe;
    });

    return {
      result,
      steer: (prompt) => execution.steer(prompt),
      interrupt: () => {
        controller.abort();
        execution.interrupt();
        const forceTimer = setTimeout(() => execution.terminate?.(), 5_000);
        forceTimer.unref?.();
      },
    };
  };
}

export function buildRemoteCodexEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const canonicalKey = key.toUpperCase();
    if (typeof value !== "string" || !SAFE_REMOTE_ENVIRONMENT_KEYS.has(canonicalKey)) continue;
    result[canonicalKey] = value;
  }
  return result;
}
