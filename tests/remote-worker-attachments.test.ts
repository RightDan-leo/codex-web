import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { validateServerMessage, type RemoteAttachmentPayload } from "../server/remote-worker-protocol.js";

function attachment(): RemoteAttachmentPayload {
  const content = Buffer.from("attachment", "utf8");
  return {
    name: "input.txt",
    mimeType: "text/plain",
    size: content.byteLength,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    contentBase64: content.toString("base64"),
  };
}

function hello(workerId: string, supportsAttachments?: boolean) {
  return {
    type: "worker.hello" as const,
    protocolVersion: 1 as const,
    workerId,
    displayName: workerId,
    capabilities: {
      platform: "linux" as const,
      arch: "x64",
      supportsSteering: true,
      supportsInterrupt: true,
      ...(supportsAttachments === undefined ? {} : { supportsAttachments }),
    },
    projects: [{ id: `project-${workerId}`, name: `Project ${workerId}` }],
  };
}

test("gateway fails clearly instead of dropping attachments on an old worker", () => {
  const gateway = new RemoteWorkerGateway();
  gateway.attach(hello("old-worker"), { send: () => {} });
  assert.throws(() => gateway.start({
    jobId: "job-old-worker",
    projectId: "project-old-worker",
    prompt: "work",
    attachments: [attachment()],
  }), /update and restart the worker/);
});

test("gateway routes attachments only after capability negotiation", async () => {
  const gateway = new RemoteWorkerGateway();
  const sent: Array<{ type: string; requestId: string; attachments?: RemoteAttachmentPayload[] }> = [];
  gateway.attach(hello("new-worker", true), { send: (message) => sent.push(message) });
  const execution = gateway.start({
    jobId: "job-new-worker",
    projectId: "project-new-worker",
    prompt: "work",
    attachments: [attachment()],
  });
  const run = sent[0];
  assert.equal(run.type, "server.run");
  assert.equal(run.attachments?.length, 1);
  assert.equal(run.attachments?.[0].name, "input.txt");
  gateway.receive("new-worker", {
    type: "worker.result",
    protocolVersion: 1,
    requestId: run.requestId,
    jobId: "job-new-worker",
    result: "done",
  });
  assert.equal(await execution.result, "done");
});

test("protocol rejects malformed attachment encoding before worker execution", () => {
  const item = attachment();
  assert.throws(() => validateServerMessage({
    type: "server.run",
    protocolVersion: 1,
    requestId: "request-invalid",
    jobId: "job-invalid",
    projectId: "project-invalid",
    prompt: "work",
    attachments: [{ ...item, size: item.size + 1 }],
  }), /size does not match/);
});
