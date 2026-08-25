import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageRemoteAttachments } from "../server/remote-attachment-staging.js";
import type { RemoteAttachmentPayload } from "../server/remote-worker-protocol.js";
import { RemoteWorkerRuntime, type RemoteCodexStartInput } from "../server/remote-worker-runtime.js";

function payload(name: string, mimeType: string, content: Buffer): RemoteAttachmentPayload {
  return {
    name,
    mimeType,
    size: content.byteLength,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    contentBase64: content.toString("base64"),
  };
}

test("worker verifies and stages attachments in a disposable runtime", () => {
  const text = Buffer.from("hello staged file", "utf8");
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const staged = stageRemoteAttachments("job-stage", "inspect the files", [
    payload("notes.txt", "text/plain", text),
    payload("screen.png", "image/png", image),
  ]);
  try {
    assert.ok(staged.runtimeRoot);
    assert.equal(fs.existsSync(staged.runtimeRoot!), true);
    assert.equal(staged.attachments.length, 2);
    assert.equal(fs.readFileSync(staged.attachments[0].absolutePath).toString("utf8"), text.toString("utf8"));
    assert.deepEqual(fs.readFileSync(staged.attachments[1].absolutePath), image);
    assert.deepEqual(staged.imagePaths, [staged.attachments[1].absolutePath]);
    assert.match(staged.prompt, /disposable worker-owned directory/);
    assert.equal(staged.prompt.includes(JSON.stringify(staged.attachments[0].absolutePath)), true);
  } finally {
    const runtimeRoot = staged.runtimeRoot!;
    staged.cleanup();
    staged.cleanup();
    assert.equal(fs.existsSync(runtimeRoot), false);
  }
});

test("worker rejects a tampered attachment and removes partial staging", () => {
  const original = payload("notes.txt", "text/plain", Buffer.from("original"));
  const tampered = { ...original, contentBase64: Buffer.from("tampered").toString("base64") };
  assert.throws(() => stageRemoteAttachments("job-tampered", "work", [tampered]), /size mismatch|digest mismatch/);
});

test("remote worker runtime cleans staged files after the Codex turn settles", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-project-"));
  let captured: RemoteCodexStartInput | undefined;
  let finish!: (value: string) => void;
  const result = new Promise<string>((resolve) => { finish = resolve; });
  const runtime = new RemoteWorkerRuntime([
    { id: "project-stage", name: "Project Stage", cwd: project },
  ], (input) => {
    captured = input;
    return { result, steer: async () => "turn", interrupt: () => {} };
  });
  const emitted: Array<{ type: string; result?: string }> = [];
  try {
    const handling = runtime.handle({
      type: "server.run",
      protocolVersion: 1,
      requestId: "request-stage",
      jobId: "job-stage-runtime",
      projectId: "project-stage",
      prompt: "read the attachment",
      attachments: [payload("input.txt", "text/plain", Buffer.from("runtime input"))],
    }, (message) => emitted.push(message));
    await Promise.resolve();
    assert.ok(captured?.runtimeRoot);
    assert.equal(fs.existsSync(captured!.runtimeRoot!), true);
    const escapedRuntimeRoot = JSON.stringify(captured!.runtimeRoot!).slice(1, -1);
    assert.equal(captured?.prompt.includes(escapedRuntimeRoot), true);
    finish("completed");
    await handling;
    assert.equal(fs.existsSync(captured!.runtimeRoot!), false);
    assert.equal(emitted.at(-1)?.type, "worker.result");
    assert.equal(emitted.at(-1)?.result, "completed");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
