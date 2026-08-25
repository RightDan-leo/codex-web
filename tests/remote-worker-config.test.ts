import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRemoteWorkerConfig } from "../server/remote-worker-config.js";

function writeConfig(root: string, value: unknown): string {
  const file = path.join(root, "remote-worker.json");
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

test("remote worker config resolves only explicitly registered local directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-worker-config-"));
  const project = path.join(root, "project");
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(project);
  fs.mkdirSync(codexHome);
  try {
    const config = loadRemoteWorkerConfig(writeConfig(root, {
      serverUrl: "https://example.test/codex-worker",
      workerId: "dev-pc",
      displayName: "Development PC",
      defaultModel: "test-model",
      defaultReasoningEffort: "medium",
      projects: [{ id: "project-a", name: "Project A", cwd: project, codexHome }],
    }));
    assert.equal(config.serverUrl, "https://example.test/codex-worker");
    assert.equal(config.projects[0].cwd, path.resolve(project));
    assert.equal(config.projects[0].codexHome, path.resolve(codexHome));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("remote worker config rejects insecure non-local HTTP servers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-worker-config-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  try {
    const file = writeConfig(root, {
      serverUrl: "http://example.test/codex-worker",
      workerId: "dev-pc",
      displayName: "Development PC",
      defaultModel: "test-model",
      defaultReasoningEffort: "medium",
      projects: [{ id: "project-a", name: "Project A", cwd: project }],
    });
    assert.throws(() => loadRemoteWorkerConfig(file), /must use HTTPS/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("remote worker config rejects missing project directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-worker-config-"));
  try {
    const file = writeConfig(root, {
      serverUrl: "http://localhost:37821/codex-worker",
      workerId: "dev-pc",
      displayName: "Development PC",
      defaultModel: "test-model",
      defaultReasoningEffort: "medium",
      projects: [{ id: "project-a", name: "Project A", cwd: path.join(root, "missing") }],
    });
    assert.throws(() => loadRemoteWorkerConfig(file), /does not exist/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("remote worker config rejects embedded credentials and unknown project overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-worker-config-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  try {
    const withToken = writeConfig(root, {
      serverUrl: "http://localhost:37821/codex-worker",
      workerId: "dev-pc",
      displayName: "Development PC",
      defaultModel: "test-model",
      defaultReasoningEffort: "medium",
      token: "a-control-token-must-never-live-in-this-file",
      projects: [{ id: "project-a", name: "Project A", cwd: project }],
    });
    assert.throws(() => loadRemoteWorkerConfig(withToken), /unsupported field/);

    const withProjectOverride = writeConfig(root, {
      serverUrl: "http://localhost:37821/codex-worker",
      workerId: "dev-pc",
      displayName: "Development PC",
      defaultModel: "test-model",
      defaultReasoningEffort: "medium",
      projects: [{ id: "project-a", name: "Project A", cwd: project, shell: "powershell" }],
    });
    assert.throws(() => loadRemoteWorkerConfig(withProjectOverride), /unsupported field/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
