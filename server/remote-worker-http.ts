import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { RemoteWorkerGateway } from "./remote-worker-gateway.js";
import { RemoteWorkerPollingHub } from "./remote-worker-polling.js";

export type RemoteWorkerHttpOptions = {
  token: string;
  path?: string;
  sessionTtlMs?: number;
};

export type RemoteWorkerHttpService = {
  gateway: RemoteWorkerGateway;
  hub: RemoteWorkerPollingHub;
  close(): void;
};

function normalizeMountPath(value: string): string {
  const normalized = `/${value}`.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "/" ? "/codex-worker" : normalized;
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
  const gateway = new RemoteWorkerGateway();
  const hub = new RemoteWorkerPollingHub(gateway, { sessionTtlMs: options.sessionTtlMs });

  function authorized(req: Request, res: Response): boolean {
    const supplied = bearerToken(req);
    if (!supplied || !sameSecret(options.token, supplied)) {
      res.status(401).setHeader("Cache-Control", "no-store");
      res.json({ error: "Remote worker authentication failed" });
      return false;
    }
    return true;
  }

  app.post(`${mountPath}/register`, (req, res) => {
    if (!authorized(req, res)) return;
    try {
      const registered = hub.register(req.body);
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json(registered);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Unable to register remote worker" });
    }
  });

  app.get(`${mountPath}/poll/:sessionId`, async (req, res) => {
    if (!authorized(req, res)) return;
    try {
      const message = await hub.poll(String(req.params.sessionId));
      res.setHeader("Cache-Control", "no-store");
      return message ? res.json({ message }) : res.status(204).end();
    } catch (error) {
      return res.status(404).json({ error: error instanceof Error ? error.message : "Remote worker session not found" });
    }
  });

  app.post(`${mountPath}/message/:sessionId`, (req, res) => {
    if (!authorized(req, res)) return;
    try {
      hub.receive(String(req.params.sessionId), req.body);
      res.setHeader("Cache-Control", "no-store");
      return res.status(204).end();
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid remote worker message" });
    }
  });

  app.delete(`${mountPath}/session/:sessionId`, (req, res) => {
    if (!authorized(req, res)) return;
    hub.close(String(req.params.sessionId), "remote worker disconnected cleanly");
    res.setHeader("Cache-Control", "no-store");
    return res.status(204).end();
  });

  app.get(`${mountPath}/status`, (req, res) => {
    if (!authorized(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    return res.json({ workers: gateway.listWorkers() });
  });

  const sweepTimer = setInterval(() => hub.sweepIdle(), 30_000);
  sweepTimer.unref?.();
  return {
    gateway,
    hub,
    close: () => {
      clearInterval(sweepTimer);
      for (const worker of gateway.listWorkers()) gateway.detach(worker.workerId, "Codex Web is shutting down");
    },
  };
}
