import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { isBrowserOriginAllowed, shouldUseSecureCookie } from "../server/request-security.js";

function securityProbe(publicBaseUrl: string) {
  const app = express();
  app.post("/probe", (req, res) => res.json({
    allowed: isBrowserOriginAllowed(req, publicBaseUrl),
    secure: shouldUseSecureCookie(req, publicBaseUrl),
  }));
  return app;
}

test("configured public URL is the browser write origin authority", async () => {
  const app = securityProbe("https://codex-node.example.ts.net/codex-web");
  const accepted = await request(app).post("/probe")
    .set("Host", "internal-container:37821")
    .set("Origin", "https://codex-node.example.ts.net")
    .expect(200);
  assert.deepEqual(accepted.body, { allowed: true, secure: true });

  const spoofed = await request(app).post("/probe")
    .set("Host", "internal-container:37821")
    .set("X-Forwarded-Host", "evil.example")
    .set("X-Forwarded-Proto", "https")
    .set("Origin", "https://evil.example")
    .expect(200);
  assert.deepEqual(spoofed.body, { allowed: false, secure: true });
});

test("local development falls back to Host and ignores forwarded headers", async () => {
  const app = securityProbe("");
  const local = await request(app).post("/probe")
    .set("Host", "localhost:37821")
    .set("Origin", "http://localhost:37821")
    .expect(200);
  assert.deepEqual(local.body, { allowed: true, secure: false });

  const spoofed = await request(app).post("/probe")
    .set("Host", "localhost:37821")
    .set("X-Forwarded-Proto", "https")
    .set("Origin", "https://evil.example")
    .expect(200);
  assert.deepEqual(spoofed.body, { allowed: false, secure: false });
});
