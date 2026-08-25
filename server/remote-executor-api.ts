import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import type { AppDatabase, SessionRow } from "./db.js";
import type { ExecutorTarget } from "./executor-router.js";
import { RemoteExecutorStore } from "./remote-executor-store.js";
import { canChangeExecutor } from "./remote-executor-policy.js";
import { RemoteWorkerGateway } from "./remote-worker-gateway.js";

const COOKIE_NAME = "cww_session";
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type RemoteExecutorApiOptions = {
  store: RemoteExecutorStore;
  gateway: RemoteWorkerGateway;
  remoteEnabled: boolean;
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
    return res.json({ workers: options.gateway.listWorkers(), enabled: options.remoteEnabled });
  });

  app.get(`${apiPath}/conversations/:id/executor`, (req, res) => {
    const session = authenticate(req, res, db, config, true);
    if (!session) return;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const executor = options.store.get(conversation.id);
    noStore(res);
    return res.json({
      executor,
      online: executor.kind === "tenant" || (options.remoteEnabled && options.gateway.hasProject(executor.projectId)),
      canChange: executorCanChange(db, conversation.id, conversation.codex_thread_id),
    });
  });

  app.put(`${apiPath}/conversations/:id/executor`, (req, res) => {
    const session = authenticate(req, res, db, config, true);
    if (!session || !verifyWriteRequest(req, res, session)) return;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });

    let target: ExecutorTarget;
    if (req.body?.kind === "tenant") {
      target = { kind: "tenant" };
    } else if (req.body?.kind === "remote" && typeof req.body?.projectId === "string") {
      const projectId = req.body.projectId.trim();
      if (!SAFE_PROJECT_ID.test(projectId)) {
        return res.status(400).json({ error: "远端项目标识无效。" });
      }
      target = { kind: "remote", projectId };
    } else {
      return res.status(400).json({ error: "执行位置设置无效。" });
    }

    const current = options.store.get(conversation.id);
    if (sameExecutorTarget(current, target)) {
      noStore(res);
      return res.json({
        executor: current,
        online: current.kind === "tenant" || (options.remoteEnabled && options.gateway.hasProject(current.projectId)),
        canChange: executorCanChange(db, conversation.id, conversation.codex_thread_id),
      });
    }

    if (!executorCanChange(db, conversation.id, conversation.codex_thread_id)) {
      return res.status(409).json({ error: "执行位置只能在会话首次运行前设置；请新建任务后再选择。" });
    }

    if (target.kind === "remote") {
      if (!options.remoteEnabled) {
        return res.status(503).json({ error: "远端执行服务未启用，请先配置 REMOTE_WORKER_TOKEN。" });
      }
      if (!options.gateway.hasProject(target.projectId)) {
        return res.status(409).json({ error: "所选远端项目当前不在线。" });
      }
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

function sameExecutorTarget(left: ExecutorTarget, right: ExecutorTarget): boolean {
  return left.kind === right.kind
    && (left.kind === "tenant" || (right.kind === "remote" && left.projectId === right.projectId));
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
    res.status(403).json({ error: "只有所有者可以管理远端执行位置。" });
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
  const expectedHost = String(req.get("host") ?? "").trim();
  try {
    if (new URL(origin).host === expectedHost) return true;
  } catch { /* Fall through to the same untrusted-origin response. */ }
  res.status(403).json({ error: "请求来源不受信任。" });
  return false;
}

export function executorCanChange(db: AppDatabase, conversationId: string, threadId: string | null): boolean {
  const draft = db.getComposerDraft(conversationId);
  return canChangeExecutor({
    hasThread: Boolean(threadId),
    messageCount: db.listMessages(conversationId).length,
    activeJobCount: db.listActiveJobsForConversation(conversationId).length,
    queuedPromptCount: db.listPendingPrompts(conversationId).length,
    editingPromptCount: db.listPendingPrompts(conversationId, "editing").length,
    hasSavedDraft: Boolean(draft),
  });
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
}
