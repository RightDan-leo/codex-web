import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppServerTurnOptions } from "../server/app-server-turn.js";
import { createRemoteCodexStarter } from "../server/remote-codex-adapter.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-adapter-"));
  const project = path.join(root, "project");
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(project);
  fs.mkdirSync(runtime);
  const image = path.join(runtime, "screen.png");
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { root, project, runtime, image };
}

test("remote Codex receives only the project and staged attachment runtime roots", async () => {
  const files = fixture();
  let captured: AppServerTurnOptions | undefined;
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
    const execution = starter({
      jobId: "job-attachment",
      cwd: files.project,
      runtimeRoot: files.runtime,
      imagePaths: [files.image],
      prompt: "inspect",
    }, {
      onThreadStarted: () => {},
      onProgress: () => {},
    });
    assert.equal(await execution.result, "done");
    assert.deepEqual(captured?.runtimeWorkspaceRoots, [files.project, files.runtime]);
    assert.deepEqual(captured?.imagePaths, [files.image]);
    assert.equal(captured?.library, files.runtime);
    assert.equal(captured?.env.CWW_REMOTE_JOB_ROOT, files.runtime);
    assert.equal(captured?.shellEnvironment.CWW_REMOTE_JOB_ROOT, files.runtime);
  } finally {
    fs.rmSync(files.root, { recursive: true, force: true });
  }
});

test("remote Codex rejects staged image paths outside the disposable runtime", () => {
  const files = fixture();
  const outside = path.join(files.project, "outside.png");
  fs.writeFileSync(outside, "outside");
  try {
    const starter = createRemoteCodexStarter({
      defaultModel: "test-model",
      defaultReasoningEffort: "medium",
    }, () => ({ result: Promise.resolve("no"), steer: async () => "turn", interrupt: () => {} }));
    assert.throws(() => starter({
      jobId: "job-escape",
      cwd: files.project,
      runtimeRoot: files.runtime,
      imagePaths: [outside],
      prompt: "inspect",
    }, {
      onThreadStarted: () => {},
      onProgress: () => {},
    }), /escapes the staged runtime/);
  } finally {
    fs.rmSync(files.root, { recursive: true, force: true });
  }
});
