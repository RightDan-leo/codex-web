import assert from "node:assert/strict";
import test from "node:test";
import type { CodexRunner } from "../server/codex-runner.js";
import type { AppDatabase } from "../server/db.js";
import type { RemoteExecutorStore } from "../server/remote-executor-store.js";
import { installRemoteRunnerRouting } from "../server/remote-runner-routing.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";

const hello = {
  type: "worker.hello" as const,
  protocolVersion: 1 as const,
  workerId: "routing-worker",
  displayName: "Routing Worker",
  capabilities: {
    platform: "linux" as const,
    arch: "x64",
    supportsSteering: true,
    supportsInterrupt: true,
  },
  projects: [{ id: "project-routing", name: "Routing Project" }],
};

function fixture() {
  const sent: Array<{ type: string; requestId: string; jobId?: string; prompt?: string }> = [];
  const gateway = new RemoteWorkerGateway();
  gateway.attach(hello, { send: (message) => sent.push(message) });
  const targets = new Map<string, { kind: "tenant" } | { kind: "remote"; projectId: string }>();
  const store = {
    get: (conversationId: string) => targets.get(conversationId) ?? { kind: "tenant" as const },
  } as RemoteExecutorStore;
  const events: Array<{ type: string; payload: unknown }> = [];
  const messages: Array<{ content: string }> = [];
  const finishes: Array<{ status: string; error?: string | null }> = [];
  const conversations = new Map([
    ["conversation-routing", {
      id: "conversation-routing",
      title_source: "default",
      codex_thread_id: null,
    }],
  ]);
  const jobs = new Map([
    ["job-routing", {
      id: "job-routing",
      conversation_id: "conversation-routing",
      message_id: "message-routing",
      status: "running",
    }],
  ]);
  const db = {
    getConversation: (id: string) => conversations.get(id),
    getJob: (id: string) => jobs.get(id),
    isFirstUserMessage: () => true,
    listMessages: () => [],
    updateJob: (id: string, status: string) => {
      const job = jobs.get(id);
      if (job) job.status = status;
    },
    updateConversation: (id: string, fields: { codexThreadId?: string }) => {
      const conversation = conversations.get(id);
      if (conversation && fields.codexThreadId) conversation.codex_thread_id = fields.codexThreadId;
    },
    listFiles: () => [],
    addMessage: (message: { content: string }) => messages.push(message),
    setAiConversationTitleIfDefault: () => true,
    finishJob: (_id: string, _conversationId: string, status: string, error?: string | null) => finishes.push({ status, error }),
  } as unknown as AppDatabase;
  let tenantRuns = 0;
  const runner = {
    get activeJobCount() { return 0; },
    run: async () => { tenantRuns += 1; },
    steer: async () => "tenant-steer",
    cancel: () => false,
    conversationRolloutBytes: () => 321,
  } as unknown as CodexRunner;
  const routing = installRemoteRunnerRouting(runner, db, {
    gateway,
    store,
    publish: (_jobId, type, payload) => events.push({ type, payload }),
  });
  return { runner, routing, gateway, sent, targets, events, messages, finishes, get tenantRuns() { return tenantRuns; } };
}

test("remote runner routing keeps tenant execution as the default", async () => {
  const context = fixture();
  await context.runner.run("job-routing", "conversation-routing", "tenant work", [], { model: "model", reasoningEffort: "medium" });
  assert.equal(context.tenantRuns, 1);
  assert.equal(context.runner.conversationRolloutBytes("conversation-routing"), 321);
});

test("remote runner routing preserves prompt context, progress, thread and completion", async () => {
  const context = fixture();
  context.targets.set("conversation-routing", { kind: "remote", projectId: "project-routing" });
  const running = context.runner.run(
    "job-routing",
    "conversation-routing",
    "修复登录流程",
    [],
    { model: "model", reasoningEffort: "high" },
  );
  await Promise.resolve();
  const run = context.sent[0];
  assert.equal(run.type, "server.run");
  assert.match(run.prompt ?? "", /修复登录流程/);
  assert.equal(context.runner.activeJobCount, 1);
  context.gateway.receive("routing-worker", {
    type: "worker.thread.started",
    protocolVersion: 1,
    requestId: run.requestId,
    jobId: "job-routing",
    threadId: "thread-routing",
  });
  context.gateway.receive("routing-worker", {
    type: "worker.progress",
    protocolVersion: 1,
    requestId: run.requestId,
    jobId: "job-routing",
    payload: { kind: "status", label: "working" },
  });
  context.gateway.receive("routing-worker", {
    type: "worker.result",
    protocolVersion: 1,
    requestId: run.requestId,
    jobId: "job-routing",
    result: "remote complete",
  });
  await running;
  assert.equal(context.messages[0].content, "remote complete");
  assert.equal(context.finishes.at(-1)?.status, "completed");
  assert.equal(context.events.some((event) => event.type === "done"), true);
  assert.equal(context.runner.activeJobCount, 0);
  assert.equal(context.runner.conversationRolloutBytes("conversation-routing"), null);
});

test("remote routing acknowledges steering without failing the main run", async () => {
  const context = fixture();
  context.targets.set("conversation-routing", { kind: "remote", projectId: "project-routing" });
  const running = context.runner.run(
    "job-routing",
    "conversation-routing",
    "start",
    [],
    { model: "model", reasoningEffort: "medium" },
  );
  await Promise.resolve();
  const run = context.sent[0];
  const steering = context.runner.steer("job-routing", "改为方案 B", []);
  const steer = context.sent[1];
  assert.equal(steer.type, "server.steer");
  assert.match(steer.prompt ?? "", /改为方案 B/);
  context.gateway.receive("routing-worker", {
    type: "worker.steered",
    protocolVersion: 1,
    requestId: steer.requestId,
    jobId: "job-routing",
    turnId: "turn-steered",
  });
  assert.equal(await steering, "turn-steered");
  context.gateway.receive("routing-worker", {
    type: "worker.result",
    protocolVersion: 1,
    requestId: run.requestId,
    jobId: "job-routing",
    result: "done",
  });
  await running;
});

test("remote routing records user cancellation and suppresses tenant fallback", async () => {
  const context = fixture();
  context.targets.set("conversation-routing", { kind: "remote", projectId: "project-routing" });
  const running = context.runner.run(
    "job-routing",
    "conversation-routing",
    "long task",
    [],
    { model: "model", reasoningEffort: "medium" },
  );
  await Promise.resolve();
  const run = context.sent[0];
  assert.equal(context.runner.cancel("job-routing"), true);
  assert.equal(context.sent[1].type, "server.cancel");
  context.gateway.receive("routing-worker", {
    type: "worker.cancelled",
    protocolVersion: 1,
    requestId: run.requestId,
    jobId: "job-routing",
  });
  await running;
  assert.equal(context.finishes.at(-1)?.status, "cancelled");
  assert.equal(context.tenantRuns, 0);
});

test("persisted remote targets fail closed while their worker is offline", async () => {
  const context = fixture();
  context.targets.set("conversation-routing", { kind: "remote", projectId: "offline-project" });
  await context.runner.run(
    "job-routing",
    "conversation-routing",
    "work",
    [],
    { model: "model", reasoningEffort: "medium" },
  );
  assert.equal(context.finishes.at(-1)?.status, "failed");
  assert.equal(context.tenantRuns, 0);
});
