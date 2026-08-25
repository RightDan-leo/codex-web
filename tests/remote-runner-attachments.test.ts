import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CodexRunner } from "../server/codex-runner.js";
import type { AppDatabase, FileRow } from "../server/db.js";
import type { RemoteExecutorStore } from "../server/remote-executor-store.js";
import { installRemoteRunnerRouting } from "../server/remote-runner-routing.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("remote runner packages conversation uploads without sending server paths", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-runner-attachments-"));
  fs.mkdirSync(path.join(workspace, "uploads"));
  const content = Buffer.from("runner attachment", "utf8");
  fs.writeFileSync(path.join(workspace, "uploads", "input.txt"), content);

  const sent: Array<{
    type: string;
    requestId: string;
    attachments?: Array<{ name: string; size: number; contentBase64: string }>;
  }> = [];
  const gateway = new RemoteWorkerGateway();
  gateway.attach({
    type: "worker.hello",
    protocolVersion: 1,
    workerId: "runner-attachment-worker",
    displayName: "Runner Attachment Worker",
    capabilities: {
      platform: "linux",
      arch: "x64",
      supportsSteering: true,
      supportsInterrupt: true,
      supportsAttachments: true,
    },
    projects: [{ id: "runner-attachment-project", name: "Runner Attachment Project" }],
  }, { send: (message) => sent.push(message) });

  const conversation = {
    id: "conversation-attachment",
    user_id: "user-attachment",
    title_source: "manual",
    codex_thread_id: null,
  };
  const job = {
    id: "job-attachment",
    conversation_id: conversation.id,
    message_id: "message-attachment",
    status: "running",
  };
  const finishes: string[] = [];
  const db = {
    getConversation: () => conversation,
    getJob: () => job,
    isFirstUserMessage: () => false,
    listMessages: () => [],
    updateJob: (_id: string, status: string) => { job.status = status; },
    updateConversation: () => {},
    listFiles: () => [],
    addMessage: () => {},
    setAiConversationTitleIfDefault: () => false,
    finishJob: (_jobId: string, _conversationId: string, status: string) => finishes.push(status),
  } as unknown as AppDatabase;
  const store = {
    get: () => ({ kind: "remote" as const, projectId: "runner-attachment-project" }),
  } as RemoteExecutorStore;
  const runner = {
    get activeJobCount() { return 0; },
    run: async () => {},
    steer: async () => "tenant-steer",
    cancel: () => false,
    conversationRolloutBytes: () => 0,
  } as unknown as CodexRunner;
  installRemoteRunnerRouting(runner, db, {
    gateway,
    store,
    publish: () => {},
    workspaceForConversation: () => workspace,
  });
  const upload: FileRow = {
    id: "file-attachment",
    conversation_id: conversation.id,
    message_id: job.message_id,
    original_name: "input.txt",
    relative_path: "uploads/input.txt",
    mime_type: "text/plain",
    size: content.byteLength,
    kind: "upload",
    created_at: new Date(0).toISOString(),
  };

  try {
    const running = runner.run(job.id, conversation.id, "read input", [upload], { model: "model", reasoningEffort: "medium" });
    for (let attempt = 0; attempt < 20 && sent.length === 0; attempt += 1) await immediate();
    const run = sent[0];
    assert.equal(run.type, "server.run");
    assert.equal(run.attachments?.length, 1);
    assert.equal(run.attachments?.[0].name, "input.txt");
    assert.equal(run.attachments?.[0].size, content.byteLength);
    assert.equal(Buffer.from(run.attachments![0].contentBase64, "base64").toString("utf8"), content.toString("utf8"));
    assert.equal(JSON.stringify(run.attachments).includes(workspace), false);
    gateway.receive("runner-attachment-worker", {
      type: "worker.result",
      protocolVersion: 1,
      requestId: run.requestId,
      jobId: job.id,
      result: "done",
    });
    await running;
    assert.equal(finishes.at(-1), "completed");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
