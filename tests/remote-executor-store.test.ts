import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase } from "../server/db.js";
import { RemoteExecutorStore } from "../server/remote-executor-store.js";

function createDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-executor-store-"));
  const db = new AppDatabase(root, { username: "owner", passwordHash: "", displayName: "Owner" }, false);
  return { root, db };
}

test("conversation executor defaults to tenant and persists remote selection", () => {
  const { root, db } = createDb();
  try {
    db.createConversation("00000000-0000-4000-8000-000000000010", "test");
    const store = new RemoteExecutorStore(db);
    assert.deepEqual(store.get("00000000-0000-4000-8000-000000000010"), { kind: "tenant" });
    const remote = store.set("00000000-0000-4000-8000-000000000010", { kind: "remote", projectId: "sample-project" });
    assert.equal(remote.kind, "remote");
    if (remote.kind === "remote") assert.equal(remote.projectId, "sample-project");
    const tenant = store.set("00000000-0000-4000-8000-000000000010", { kind: "tenant" });
    assert.equal(tenant.kind, "tenant");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conversation executor rejects unknown conversations and invalid project ids", () => {
  const { root, db } = createDb();
  try {
    const store = new RemoteExecutorStore(db);
    assert.throws(() => store.set("00000000-0000-4000-8000-000000000099", { kind: "remote", projectId: "project" }), /Conversation does not exist/);
    db.createConversation("00000000-0000-4000-8000-000000000011", "test");
    assert.throws(() => store.set("00000000-0000-4000-8000-000000000011", { kind: "remote", projectId: "../escape" }), /Invalid remote executor project id/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("executor rows are removed when their conversation is deleted", () => {
  const { root, db } = createDb();
  try {
    const conversationId = "00000000-0000-4000-8000-000000000012";
    db.createConversation(conversationId, "test");
    const store = new RemoteExecutorStore(db);
    store.set(conversationId, { kind: "remote", projectId: "project-a" });
    db.sqlite.prepare("DELETE FROM conversations WHERE id=?").run(conversationId);
    const row = db.sqlite.prepare("SELECT 1 AS found FROM conversation_executors WHERE conversation_id=?").get(conversationId);
    assert.equal(row, undefined);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("executor rows are removed when a conversation is soft deleted", () => {
  const { root, db } = createDb();
  try {
    const conversationId = "00000000-0000-4000-8000-000000000013";
    db.createConversation(conversationId, "test");
    const store = new RemoteExecutorStore(db);
    store.set(conversationId, { kind: "remote", projectId: "project-a" });
    db.softDeleteConversation(conversationId);
    const row = db.sqlite.prepare("SELECT 1 AS found FROM conversation_executors WHERE conversation_id=?").get(conversationId);
    assert.equal(row, undefined);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
