import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneStaleRemoteAttachmentRuntimes } from "../server/remote-attachment-staging.js";

test("worker startup removes stale attachment runtimes but keeps fresh ones", () => {
  const baseRoot = path.join(os.tmpdir(), "codex-web-remote-worker");
  fs.mkdirSync(baseRoot, { recursive: true });
  const unique = `${process.pid}-${Date.now()}`;
  const stale = path.join(baseRoot, `stale-test-${unique}`);
  const fresh = path.join(baseRoot, `fresh-test-${unique}`);
  fs.mkdirSync(stale);
  fs.mkdirSync(fresh);
  const now = Date.now();
  fs.utimesSync(stale, new Date(now - 5 * 60_000), new Date(now - 5 * 60_000));
  fs.utimesSync(fresh, new Date(now), new Date(now));
  try {
    const removed = pruneStaleRemoteAttachmentRuntimes(2 * 60_000, now);
    assert.equal(removed >= 1, true);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});
