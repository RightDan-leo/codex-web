import fs from "node:fs";
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

    const controller = new AbortController();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (input.codexHome) env.CODEX_HOME = input.codexHome;
    const shellEnvironment = Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );

    const execution = startTurn({
      ...(config.executablePath ? { executablePath: config.executablePath } : {}),
      cwd: input.cwd,
      env,
      threadId: input.threadId ?? null,
      prompt: input.prompt,
      imagePaths: [],
      model: input.model ?? config.defaultModel,
      reasoningEffort: input.reasoningEffort ?? config.defaultReasoningEffort,
      library: input.cwd,
      shellEnvironment,
      networkAccessEnabled: config.networkAccessEnabled ?? true,
      webSearchMode: config.webSearchMode ?? "live",
      sandbox: config.sandbox ?? "workspace-write",
      runtimeWorkspaceRoots: [input.cwd],
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
