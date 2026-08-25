import crypto from "node:crypto";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { RemoteWorkerGateway } from "./remote-worker-gateway.js";
import { RemoteWorkerPollingHub } from "./remote-worker-polling.js";

export type RemoteWorkerHttpOptions = {
  token: string;
  path?: string;
  sessionTtlMs?: number;
  gateway?: RemoteWorkerGateway;
};

export type RemoteWorkerHttpService = {
  gateway: RemoteWorkerGateway;
  hub: RemoteWorkerPollingHub;
  close(): void;
};

function normalizeMountPath(value: string): string {
  const normalized = `/${value}`.replace(/\/+/g, "/").replace(/\/$/, "");
  const result = normalized === "/" ? "/codex-worker" : normalized;
  if (result.length > 160 || result.split("/").some((segment) => segment === "." || segment === "..") || !/^\/(?:[A-Za-z0-9._~-]+\/?)+$/.test(result)) {
    throw new Error("REMOTE_WORKER_PATH is invalid");
  }
  return result;
}

function bearerToken(req: Request): string {
  const header = req.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function sameSecret(expected: string, actual: string): boolean {
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  const actualDigest = crypto.createHash("sha256").update(actual).digest();
  return crypto.timingSafeEqual(expectedDigest, actualDigest);
}

export function installRemoteWorkerHttpRoutes(
  app: Express,
  options: RemoteWorkerHttpOptions,
): RemoteWorkerHttpService {
  if (options.token.length < 32) throw new Error("REMOTE_WORKER_TOKEN must contain at least 32 characters");
  const mountPath = normalizeMountPath(options.path ?? "/codex-worker");
  const gateway = options.gateway ?? new RemoteWorkerGateway();
  const hub = new RemoteWorkerPollingHub(gateway, { sessionTtlMs: options.sessionTtlMs });
  const router = express.Router({ strict: true });
  let closed = false;

  function available(res: Response): boolean {
    if (!closed) return true;
    res.status(503).setHeader("Cache-Control", "no-store");
    res.json({ error: "Remote worker service is shutting down" });
    return false;
  }

  function authorized(req: Request, res: Response): boolean {
    const supplied = bearerToken(req);
    if (!supplied || !sameSecret(options.token, supplied)) {
      res.status(401).setHeader("Cache-Control", "no-store");
      res.json({ error: "Remote worker authentication failed" });
      return false;
    }
    return true;
  }

  router.use(express.json({ limit: "768kb", strict: true }));

  router.post("/register", (req, res) => {
    if (!available(res) || !authorized(req, res)) return;
    try {
      const registered = hub.register(req.body);
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json(registered);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to register remote worker";
      return res.status(/already registered|reconnected/i.test(message) ? 409 : 400).json({ error: message });
    }
  });

  router.get("/poll/:sessionId", async (req, res) => {
    if (!available(res) || !authorized(req, res)) return;
    const sessionId = String(req.params.sessionId);
    const cancelPoll = () => {
      if (!res.writableEnded) hub.cancelPoll(sessionId);
    };
    res.once("close", cancelPoll);
    try {
      const message = await hub.poll(sessionId);
      if (res.destroyed || res.writableEnded) return;
      res.setHeader("Cache-Control", "no-store");
      return message ? res.json({ message }) : res.status(204).end();
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const message = error instanceof Error ? error.message : "Remote worker session not found";
      return res.status(/active poll/i.test(message) ? 409 : 404).json({ error: message });
    } finally {
      res.off("close", cancelPoll);
    }
  });

  router.post("/message/:sessionId", (req, res) => {
    if (!available(res) || !authorized(req, res)) return;
    try {
      hub.receive(String(req.params.sessionId), req.body);
      res.setHeader("Cache-Control", "no-store");
      return res.status(204).end();
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid remote worker message" });
    }
  });

  router.delete("/session/:sessionId", (req, res) => {
    if (!authorized(req, res)) return;
    hub.close(String(req.params.sessionId), "remote worker disconnected cleanly");
    res.setHeader("Cache-Control", "no-store");
    return res.status(204).end();
  });

  router.get("/status", (req, res) => {
    if (!available(res) || !authorized(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    return res.json({ workers: gateway.listWorkers() });
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    const status = typeof error === "object" && error && "type" in error && error.type === "entity.too.large" ? 413 : 400;
    return res.status(status).json({ error: status === 413 ? "Remote worker message exceeds the size limit" : "Invalid remote worker JSON body" });
  });
  app.use(mountPath, router);

  const sweepTimer = setInterval(() => hub.sweepIdle(), 30_000);
  sweepTimer.unref?.();
  return {
    gateway,
    hub,
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(sweepTimer);
      hub.closeAll("Codex Web is shutting down");
    },
  };
}
