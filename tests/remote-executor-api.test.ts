import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { installRemoteExecutorApiRoutes } from "../server/remote-executor-api.js";
import { RemoteExecutorStore } from "../server/remote-executor-store.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { ensureTenant } from "../server/paths.js";

const hello = {
  type: "worker.hello" as const,
  protocolVersion: 1 as const,
  workerId: "api-worker",
  displayName: "API Worker",
  capabilities: {
    platform: "linux" as const,
    arch: "x64",
    supportsSteering: true,
    supportsInterrupt: true,
  },
  projects: [{ id: "api-project", name: "API Project" }],
};

function fixture(remoteEnabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-api-"));
  const sessionSecret = "remote-api-session-secret-at-least-32-characters";
  const config = loadConfig({
    dataRoot: root,
    tenantRoot: path.join(root, "tenants"),
    projectRoot: root,
    basePath: "/codex-web",
    sessionSecret,
  });
  const db = new AppDatabase(root, { username: "owner", passwordHash: "", displayName: "Owner" }, false);
  const conversationId = "00000000-0000-4000-8000-000000000050";
  db.createConversation(conversationId, "test");
  const sessionToken = "remote-api-browser-session";
  const csrfToken = "remote-api-csrf-token";
  db.createSession(
    crypto.createHmac("sha256", sessionSecret).update(sessionToken).digest("hex"),
    csrfToken,
    new Date(Date.now() + 60_000).toISOString(),
  );
  const memberId = "00000000-0000-4000-8000-000000000060";
  const now = new Date().toISOString();
  db.createUser({
    id: memberId,
    username: "member",
    display_name: "Member",
    password_hash: "",
    role: "member",
    status: "active",
    created_at: now,
    updated_at: now,
  });
  const memberSessionToken = "remote-api-member-session";
  db.createSession(
    crypto.createHmac("sha256", sessionSecret).update(memberSessionToken).digest("hex"),
    "remote-api-member-csrf",
    new Date(Date.now() + 60_000).toISOString(),
    memberId,
  );
  const gateway = new RemoteWorkerGateway();
  gateway.attach(hello, { send: () => {} });
  const store = new RemoteExecutorStore(db);
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  installRemoteExecutorApiRoutes(app, db, config, { gateway, store, remoteEnabled });
  return { root, db, app, store, conversationId, sessionToken, csrfToken, memberSessionToken };
}

test("remote executor routes are installed by createApp", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-create-app-remote-api-"));
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    queueAutoStart: false,
    passwordHash: "",
    sessionSecret: "create-app-remote-route-secret-at-least-32-characters",
  });
  try {
    await request(instance.app).get("/codex-web/api/remote-workers").expect(401);
  } finally {
    await instance.runner.close();
    instance.remoteWorkerService?.close();
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deleting a remote conversation does not delete a same-id tenant rollout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-delete-remote-conversation-"));
  const sessionSecret = "delete-remote-conversation-secret-at-least-32-characters";
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot,
    queueAutoStart: false,
    passwordHash: "",
    sessionSecret,
  });
  const conversationId = "00000000-0000-4000-8000-000000000070";
  const threadId = "00000000-0000-4000-8000-000000000071";
  const sessionToken = "delete-remote-session";
  const csrfToken = "delete-remote-csrf";
  try {
    instance.db.createConversation(conversationId, "remote delete");
    instance.remoteExecutorStore.set(conversationId, { kind: "remote", projectId: "disposable-project" });
    instance.db.updateConversation(conversationId, { codexThreadId: threadId });
    instance.db.createSession(
      crypto.createHmac("sha256", sessionSecret).update(sessionToken).digest("hex"),
      csrfToken,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const sessionsRoot = path.join(ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome, "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const unrelatedTenantRollout = path.join(sessionsRoot, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(unrelatedTenantRollout, "tenant data", "utf8");

    await request(instance.app)
      .delete(`/codex-web/api/conversations/${conversationId}`)
      .set("Cookie", `cww_session=${sessionToken}`)
      .set("X-CSRF-Token", csrfToken)
      .expect(204);
    assert.equal(fs.existsSync(unrelatedTenantRollout), true);
    const executorRow = instance.db.sqlite.prepare("SELECT 1 FROM conversation_executors WHERE conversation_id=?").get(conversationId);
    assert.equal(executorRow, undefined);
  } finally {
    await instance.runner.close();
    instance.remoteWorkerService?.close();
    instance.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote executor APIs reject unauthenticated, member, CSRF and spoofed-origin requests", async () => {
  const context = fixture();
  try {
    const ownerCookie = `cww_session=${context.sessionToken}`;
    const memberCookie = `cww_session=${context.memberSessionToken}`;
    await request(context.app).get("/codex-web/api/remote-workers").expect(401);
    await request(context.app).get("/codex-web/api/remote-workers").set("Cookie", memberCookie).expect(403);
    await request(context.app)
      .get(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", memberCookie)
      .expect(403);
    await request(context.app)
      .put(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", ownerCookie)
      .send({ kind: "remote", projectId: "api-project" })
      .expect(403);
    await request(context.app)
      .put(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", context.csrfToken)
      .set("Host", "codex.example")
      .set("X-Forwarded-Host", "evil.example")
      .set("Origin", "https://evil.example")
      .send({ kind: "remote", projectId: "api-project" })
      .expect(403);
    assert.equal(context.store.get(context.conversationId).kind, "tenant");
  } finally {
    context.db.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("owner API lists connected workers and permits selection on a blank conversation", async () => {
  const context = fixture();
  try {
    const cookie = `cww_session=${context.sessionToken}`;
    const workers = await request(context.app)
      .get("/codex-web/api/remote-workers")
      .set("Cookie", cookie)
      .set("Accept", "application/json")
      .expect(200);
    assert.equal(workers.body.enabled, true);
    assert.equal(workers.body.workers[0].workerId, "api-worker");

    const before = await request(context.app)
      .get(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(before.body.canChange, true);

    const updated = await request(context.app)
      .put(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", context.csrfToken)
      .send({ kind: "remote", projectId: "api-project" })
      .expect(200);
    assert.equal(updated.body.executor.kind, "remote");
    assert.equal(updated.body.online, true);
    assert.equal(context.store.get(context.conversationId).kind, "remote");
  } finally {
    context.db.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("saved text or attachment drafts lock executor selection", async () => {
  const context = fixture();
  try {
    const cookie = `cww_session=${context.sessionToken}`;
    context.db.saveComposerDraft(context.conversationId, "draft text", null);
    const state = await request(context.app)
      .get(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(state.body.canChange, false);

    await request(context.app)
      .put(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", context.csrfToken)
      .send({ kind: "remote", projectId: "api-project" })
      .expect(409);
  } finally {
    context.db.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("executor selection locks after conversation work begins but a no-op remains readable", async () => {
  const context = fixture();
  try {
    const cookie = `cww_session=${context.sessionToken}`;
    await request(context.app)
      .put(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", context.csrfToken)
      .send({ kind: "remote", projectId: "api-project" })
      .expect(200);

    context.db.addMessage({
      id: "00000000-0000-4000-8000-000000000051",
      conversation_id: context.conversationId,
      role: "user",
      content: "started",
      created_at: new Date().toISOString(),
    });

    const selected = await request(context.app)
      .get(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(selected.body.canChange, false);

    await request(context.app)
      .put(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", context.csrfToken)
      .send({ kind: "tenant" })
      .expect(409);

    const noOp = await request(context.app)
      .put(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", context.csrfToken)
      .send({ kind: "remote", projectId: "api-project" })
      .expect(200);
    assert.equal(noOp.body.canChange, false);
  } finally {
    context.db.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("remote selection reports disabled transport instead of treating an in-memory gateway as enabled", async () => {
  const context = fixture(false);
  try {
    const cookie = `cww_session=${context.sessionToken}`;
    const workers = await request(context.app)
      .get("/codex-web/api/remote-workers")
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(workers.body.enabled, false);

    await request(context.app)
      .put(`/codex-web/api/conversations/${context.conversationId}/executor`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", context.csrfToken)
      .send({ kind: "remote", projectId: "api-project" })
      .expect(503);
  } finally {
    context.db.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});
