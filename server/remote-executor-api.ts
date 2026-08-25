import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import type { AppDatabase, SessionRow } from "./db.js";
import type { ExecutorTarget } from "./executor-router.js";
import { RemoteExecutorStore } from "./remote-executor-store.js";
import { RemoteWorkerGateway } from "./remote-worker-gateway.js";

const COOKIE_NAME = "cww_session";

export type RemoteExecutorApiOptions = {
  store: RemoteExecutorStore;
  gateway: RemoteWorkerGateway;
};

/** Install owner-facing executor endpoints without changing the public core API router. */
export function installRemoteExecutorApiRoutes(
  app: Express,
  db: AppDatabase,
  config: AppConfig,
  options: RemoteExecutorApiOptions,
): void {
  const apiPath = normalizeApiPath(config.basePath);

  app.get(`${apiPath}/remote-workers`, (req, res) => {
    const session = authenticate(req, res, db, config, true);
    if (!session) return;
    noStore(res);
    return res.json({ workers: options.gateway.listWorkers() });
  });

  app.get(`${apiPath}/conversations/:id/executor`, (req, res) => {
    const session = authenticate(req, res, db, config);
    if (!session) return;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const executor = options.store.get(conversation.id);
    noStore(res);
    return res.json({
      executor,
      online: executor.kind === "tenant" || options.gateway.hasProject(executor.projectId),
      canChange: executorCanChange(db, conversation.id, conversation.codex_thread_id),
    });
  });

  app.put(`${apiPath}/conversations/:id/executor`, (req, res) => {
    const session = authenticate(req, res, db, config, true);
    if (!session || !verifyWriteRequest(req, res, session)) return;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (!executorCanChange(db, conversation.id, conversation.codex_thread_id)) {
      return res.status(409).json({ error: "只能在尚未发送消息、没有草稿或排队任务的新会话中选择执行位置。" });
    }

    let target: ExecutorTarget;
    if (req.body?.kind === "tenant") {
      target = { kind: "tenant" };
    } else if (req.body?.kind === "remote" && typeof req.body?.projectId === "string") {
      const projectId = req.body.projectId.trim();
      if (!options.gateway.hasProject(projectId)) {
        return res.status(409).json({ error: "所选远程项目当前不在线。" });
      }
      target = { kind: "remote", projectId };
    } else {
      return res.status(400).json({ error: "执行位置设置无效。" });
    }

    try {
      const executor = options.store.set(conversation.id, target);
      noStore(res);
      return res.json({ executor, online: true, canChange: true });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "执行位置设置无效。" });
    }
  });
}

function normalizeApiPath(basePath: string): string {
  const prefix = basePath && basePath !== "/" ? basePath.replace(/\/$/, "") : "";
  return `${prefix}/api`;
}

function authenticate(
  req: Request,
  res: Response,
  db: AppDatabase,
  config: AppConfig,
  ownerOnly = false,
): SessionRow | undefined {
  const token = req.cookies?.[COOKIE_NAME];
  const session = typeof token === "string" && token
    ? db.getSession(crypto.createHmac("sha256", config.sessionSecret).update(token).digest("hex"))
    : undefined;
  if (!session) {
    res.status(401).json({ error: "请先登录。" });
    return undefined;
  }
  if (ownerOnly && session.role !== "owner") {
    res.status(403).json({ error: "只有所有者可以管理远程执行位置。" });
    return undefined;
  }
  return session;
}

function verifyWriteRequest(req: Request, res: Response, session: SessionRow): boolean {
  if (req.get("x-csrf-token") !== session.csrf_token) {
    res.status(403).json({ error: "安全校验失败，请刷新页面后重试。" });
    return false;
  }
  const origin = req.get("origin");
  if (!origin) return true;
  const expectedHost = String(req.headers["x-forwarded-host"] ?? req.get("host") ?? "").split(",")[0].trim();
  try {
    if (new URL(origin).host === expectedHost) return true;
  } catch { /* Fall through to the same untrusted-origin response. */ }
  res.status(403).json({ error: "请求来源不受信任。" });
  return false;
}

function executorCanChange(db: AppDatabase, conversationId: string, threadId: string | null): boolean {
  if (threadId || db.listMessages(conversationId).length > 0) return false;
  if (db.listActiveJobsForConversation(conversationId).length > 0) return false;
  if (db.listPendingPrompts(conversationId).length > 0 || db.listPendingPrompts(conversationId, "editing").length > 0) return false;
  const draft = db.getComposerDraft(conversationId);
  return !draft || (!draft.content && !draft.quote_excerpt && draft.files.length === 0);
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
}
