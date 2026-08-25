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

const SAFE_SHELL_ENVIRONMENT_KEYS = new Set([
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "SHELL",
  "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR",
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
    if (!stat?.isDirectory()) throw new Error(`Remote project cwd does not exist: ${input.cwd}`);

    if (input.codexHome) {
      const codexHomeStat = fs.statSync(input.codexHome, { throwIfNoEntry: false });
      if (!codexHomeStat?.isDirectory()) throw new Error(`Remote project CODEX_HOME does not exist: ${input.codexHome}`);
    }

    const runtimeRoot = input.runtimeRoot ? path.resolve(input.runtimeRoot) : undefined;
    if (runtimeRoot) {
      const runtimeStat = fs.statSync(runtimeRoot, { throwIfNoEntry: false });
      if (!runtimeStat?.isDirectory()) throw new Error(`Remote job runtime does not exist: ${runtimeRoot}`);
    }
    const imagePaths = (input.imagePaths ?? []).map((imagePath) => {
      if (!runtimeRoot) throw new Error("Remote image attachment requires a staged runtime directory");
      const resolved = path.resolve(imagePath);
      if (resolved !== runtimeRoot && !resolved.startsWith(`${runtimeRoot}${path.sep}`)) {
        throw new Error("Remote image path escapes the staged runtime directory");
      }
      const imageStat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (!imageStat?.isFile()) throw new Error(`Remote image attachment does not exist: ${resolved}`);
      return resolved;
    });

    const controller = new AbortController();
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The bearer token is only for the worker-to-server control channel. The
    // Codex app-server and its spawned shell commands must never inherit it.
    delete env.REMOTE_WORKER_TOKEN;
    if (input.codexHome) env.CODEX_HOME = input.codexHome;
    if (runtimeRoot) env.CWW_REMOTE_JOB_ROOT = runtimeRoot;
    const shellEnvironment = safeShellEnvironment(env);
    const runtimeWorkspaceRoots = runtimeRoot ? [input.cwd, runtimeRoot] : [input.cwd];

    const execution = startTurn({
      ...(config.executablePath ? { executablePath: config.executablePath } : {}),
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

    return {
      result: execution.result,
      steer: (prompt) => execution.steer(prompt),
      interrupt: () => {
        controller.abort();
        execution.interrupt();
      },
    };
  };
}

function safeShellEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !SAFE_SHELL_ENVIRONMENT_KEYS.has(key.toUpperCase())) continue;
    result[key] = value;
  }
  return result;
}
