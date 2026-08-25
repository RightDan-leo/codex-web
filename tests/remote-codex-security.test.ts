import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRemoteCodexStarter } from "../server/remote-codex-adapter.js";

test("remote Codex adapter keeps worker authentication secrets out of Codex and shell environments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-security-"));
  const previousToken = process.env.REMOTE_WORKER_TOKEN;
  const previousSecret = process.env.CWW_TEST_PRIVATE_SECRET;
  process.env.REMOTE_WORKER_TOKEN = "worker-control-token-that-must-not-leak";
  process.env.CWW_TEST_PRIVATE_SECRET = "private-value";
  let captured: { env: NodeJS.ProcessEnv; shellEnvironment: Record<string, string> } | undefined;
  try {
    const starter = createRemoteCodexStarter({
      defaultModel: "test-model",
      defaultReasoningEffort: "medium",
    }, (options) => {
      captured = options;
      return {
        result: Promise.resolve("done"),
        steer: async () => "turn",
        interrupt: () => {},
      };
    });
    const execution = starter({ jobId: "job-security", cwd: root, prompt: "work" }, {
      onThreadStarted: () => {},
      onProgress: () => {},
    });
    assert.equal(await execution.result, "done");
    assert.equal(captured?.env.REMOTE_WORKER_TOKEN, undefined);
    assert.equal(captured?.shellEnvironment.REMOTE_WORKER_TOKEN, undefined);
    assert.equal(captured?.shellEnvironment.CWW_TEST_PRIVATE_SECRET, undefined);
    assert.equal(captured?.env.CWW_TEST_PRIVATE_SECRET, "private-value");
    if (process.env.PATH) assert.equal(captured?.shellEnvironment.PATH, process.env.PATH);
  } finally {
    if (previousToken === undefined) delete process.env.REMOTE_WORKER_TOKEN;
    else process.env.REMOTE_WORKER_TOKEN = previousToken;
    if (previousSecret === undefined) delete process.env.CWW_TEST_PRIVATE_SECRET;
    else process.env.CWW_TEST_PRIVATE_SECRET = previousSecret;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
