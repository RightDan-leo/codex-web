import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { RemoteWorkerPollingHub } from "../server/remote-worker-polling.js";
import { RemoteWorkerRuntime, type RemoteCodexStartInput } from "../server/remote-worker-runtime.js";

test("mock worker completes resume, steer and cancel in a disposable Git project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-e2e-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  execFileSync("git", ["init", "--quiet", project], { windowsHide: true });

  const inputs: RemoteCodexStartInput[] = [];
  const finishers: Array<(value: string) => void> = [];
  const steers: string[] = [];
  const runtime = new RemoteWorkerRuntime([
    { id: "disposable-project", name: "Disposable Project", cwd: fs.realpathSync.native(project) },
  ], (input, callbacks) => {
    inputs.push(input);
    callbacks.onThreadStarted(input.threadId ?? "thread-disposable");
    callbacks.onProgress({ phase: "working", run: inputs.length });
    let finish!: (value: string) => void;
    const result = new Promise<string>((resolve) => { finish = resolve; });
    finishers.push(finish);
    return {
      result,
      steer: async (prompt) => { steers.push(prompt); return "turn-steered"; },
      interrupt: () => {},
    };
  });

  const gateway = new RemoteWorkerGateway({ commandTimeoutMs: 1_000 });
  const hub = new RemoteWorkerPollingHub(gateway);
  const { sessionId } = hub.register({
    type: "worker.hello",
    protocolVersion: 1,
    workerId: "disposable-worker",
    displayName: "Disposable Worker",
    capabilities: {
      platform: process.platform as "linux" | "darwin" | "win32",
      arch: process.arch,
      supportsSteering: true,
      supportsInterrupt: true,
    },
    projects: [{ id: "disposable-project", name: "Disposable Project" }],
  });

  const beginDelivery = async () => {
    const message = await hub.poll(sessionId);
    assert.ok(message);
    const handling = runtime.handle(message, (response) => hub.receive(sessionId, response));
    return { message, handling };
  };

  try {
    const threads: string[] = [];
    const progress: unknown[] = [];
    const first = gateway.start({
      jobId: "job-e2e-first",
      projectId: "disposable-project",
      prompt: "write a disposable test file",
    }, {
      onThreadStarted: (threadId) => threads.push(threadId),
      onProgress: (payload) => progress.push(payload),
    });
    const firstDelivery = await beginDelivery();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(inputs[0].cwd, fs.realpathSync.native(project));
    assert.equal(firstDelivery.message.type, "server.run");
    assert.equal("cwd" in firstDelivery.message, false);
    assert.deepEqual(threads, ["thread-disposable"]);
    assert.deepEqual(progress, [{ phase: "working", run: 1 }]);

    const steering = first.steer("also add a marker");
    const steerMessage = await hub.poll(sessionId);
    assert.equal(steerMessage?.type, "server.steer");
    await runtime.handle(steerMessage!, (response) => hub.receive(sessionId, response));
    assert.equal(await steering, "turn-steered");
    assert.deepEqual(steers, ["also add a marker"]);

    finishers[0]("first complete");
    await firstDelivery.handling;
    assert.equal(await first.result, "first complete");

    const second = gateway.start({
      jobId: "job-e2e-second",
      projectId: "disposable-project",
      prompt: "resume the task",
      codexThreadId: "thread-disposable",
    });
    const secondDelivery = await beginDelivery();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(inputs[1].threadId, "thread-disposable");
    finishers[1]("second complete");
    await secondDelivery.handling;
    assert.equal(await second.result, "second complete");

    const cancelled = gateway.start({
      jobId: "job-e2e-cancel",
      projectId: "disposable-project",
      prompt: "wait for cancellation",
    });
    const cancelledDelivery = await beginDelivery();
    await new Promise<void>((resolve) => setImmediate(resolve));
    cancelled.interrupt();
    await assert.rejects(cancelled.result, /cancelled/i);
    const cancelMessage = await hub.poll(sessionId);
    assert.equal(cancelMessage?.type, "server.cancel");
    await runtime.handle(cancelMessage!, (response) => hub.receive(sessionId, response));
    finishers[2]("late result must be ignored");
    await cancelledDelivery.handling;
    assert.equal(runtime.activeRunCount, 0);
  } finally {
    runtime.shutdown();
    hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
