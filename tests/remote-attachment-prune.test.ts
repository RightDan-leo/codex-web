import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneStaleRemoteAttachmentRuntimes } from "../server/remote-attachment-staging.js";

test("worker startup removes stale attachment runtimes but keeps fresh ones", () => {
  const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-prune-test-"));
  const stale = path.join(baseRoot, "stale");
  const fresh = path.join(baseRoot, "fresh");
  fs.mkdirSync(stale);
  fs.mkdirSync(fresh);
  const now = Date.now();
  fs.utimesSync(stale, new Date(now - 5 * 60_000), new Date(now - 5 * 60_000));
  fs.utimesSync(fresh, new Date(now), new Date(now));
  try {
    const removed = pruneStaleRemoteAttachmentRuntimes({
      maxAgeMs: 2 * 60_000,
      now,
      baseRoot,
    });
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    fs.rmSync(baseRoot, { recursive: true, force: true });
  }
});
