import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startAppServerTurn } from "../server/app-server-turn.js";
import { DEFAULT_OPTIONAL_AGENT_CAPABILITIES } from "../server/optional-capabilities.js";
import { dynamicToolsetFingerprint, planDynamicToolThread, type DynamicToolSpec } from "../server/app-server-dynamic-tools.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server-dynamic-tool.mjs");
const specs: DynamicToolSpec[] = [{
  type: "namespace",
  name: "taskboard",
  description: "test taskboard",
  tools: [{ type: "function", name: "list_projects", description: "list", inputSchema: { type: "object" } }],
}];

test("dynamic tool fingerprints are stable and change with the advertised contract", () => {
  assert.equal(dynamicToolsetFingerprint(undefined), null);
  assert.equal(dynamicToolsetFingerprint(specs), dynamicToolsetFingerprint(structuredClone(specs)));
  const changed = structuredClone(specs);
  if (changed[0]?.type === "namespace") changed[0].tools[0]!.description = "changed";
  assert.notEqual(dynamicToolsetFingerprint(specs), dynamicToolsetFingerprint(changed));
});

test("dynamic tool thread planning migrates legacy threads exactly once", () => {
  const fingerprint = dynamicToolsetFingerprint(specs)!;
  assert.deepEqual(planDynamicToolThread(null, null, specs), {
    threadId: null,
    dynamicTools: specs,
    desiredToolset: fingerprint,
    migratesLegacyThread: false,
  });
  assert.deepEqual(planDynamicToolThread("thread-legacy", null, specs), {
    threadId: null,
    dynamicTools: specs,
    desiredToolset: fingerprint,
    migratesLegacyThread: true,
  });
  assert.deepEqual(planDynamicToolThread("thread-ready", fingerprint, specs), {
    threadId: "thread-ready",
    dynamicTools: undefined,
    desiredToolset: fingerprint,
    migratesLegacyThread: false,
  });
});

test("App Server dynamic tool requests complete a controlled round trip", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const execution = startAppServerTurn({
    executablePath: process.execPath,
    appServerArgs: [fixture],
    cwd: process.cwd(),
    env: process.env,
    threadId: null,
    prompt: "use taskboard",
    imagePaths: [],
    model: "gpt-test",
    reasoningEffort: "high",
    library: process.cwd(),
    shellEnvironment: {},
    networkAccessEnabled: false,
    webSearchMode: "cached",
    optionalCapabilities: { ...DEFAULT_OPTIONAL_AGENT_CAPABILITIES },
    dynamicTools: specs,
  }, {
    signal: controller.signal,
    onThreadStarted: (threadId) => assert.equal(threadId, "thread-fake"),
    onProgress: () => undefined,
    onDynamicToolCall: (call) => {
      calls.push(`${call.namespace}.${call.tool}`);
      return { success: true, value: { projects: [{ id: "project-fake" }] } };
    },
  });
  assert.equal(await execution.result, "tool round trip complete");
  assert.deepEqual(calls, ["taskboard.list_projects"]);
});

test("resumed App Server threads use tools already attached to the persisted thread", async () => {
  const calls: string[] = [];
  const execution = startAppServerTurn({
    executablePath: process.execPath,
    appServerArgs: [fixture],
    cwd: process.cwd(),
    env: process.env,
    threadId: "thread-existing",
    prompt: "edit taskboard",
    imagePaths: [],
    model: "gpt-test",
    reasoningEffort: "high",
    library: process.cwd(),
    shellEnvironment: {},
    networkAccessEnabled: false,
    webSearchMode: "cached",
    optionalCapabilities: { ...DEFAULT_OPTIONAL_AGENT_CAPABILITIES },
  }, {
    signal: new AbortController().signal,
    onThreadStarted: (threadId) => assert.equal(threadId, "thread-existing"),
    onProgress: () => undefined,
    onDynamicToolCall: (call) => {
      calls.push(`${call.namespace}.${call.tool}`);
      return { success: true, value: { projects: [{ id: "project-fake" }] } };
    },
  });
  assert.equal(await execution.result, "tool round trip complete");
  assert.deepEqual(calls, ["taskboard.list_projects"]);
});

test("App Server refuses to silently ignore dynamic tools on thread resume", async () => {
  const execution = startAppServerTurn({
    executablePath: process.execPath,
    appServerArgs: [fixture],
    cwd: process.cwd(),
    env: process.env,
    threadId: "thread-legacy",
    prompt: "edit taskboard",
    imagePaths: [],
    model: "gpt-test",
    reasoningEffort: "high",
    library: process.cwd(),
    shellEnvironment: {},
    networkAccessEnabled: false,
    webSearchMode: "cached",
    optionalCapabilities: { ...DEFAULT_OPTIONAL_AGENT_CAPABILITIES },
    dynamicTools: specs,
  }, {
    signal: new AbortController().signal,
    onThreadStarted: () => assert.fail("legacy thread must not be resumed with new tools"),
    onProgress: () => undefined,
  });
  await assert.rejects(execution.result, /only be attached when starting a new Codex thread/);
});
