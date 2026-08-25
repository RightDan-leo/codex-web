import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { loadConfig } from "../server/config.js";
import { AppDatabase } from "../server/db.js";
import { installRemoteExecutorApiRoutes } from "../server/remote-executor-api.js";
import { RemoteExecutorStore } from "../server/remote-executor-store.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";

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
  const gateway = new RemoteWorkerGateway();
  gateway.attach(hello, { send: () => {} });
  const store = new RemoteExecutorStore(db);
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  installRemoteExecutorApiRoutes(app, db, config, { gateway, store, remoteEnabled });
  return { root, db, app, store, conversationId, sessionToken, csrfToken };
}

test("owner API lists connected workers and permits selection after a text-only draft", async () => {
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

    context.db.saveComposerDraft(context.conversationId, "draft text", null);
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
