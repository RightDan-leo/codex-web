import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Nginx buffer probe rejects wrong owner and succeeds without leaving files", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nginx-buffer-check-"));
  try {
    fs.chmodSync(root, 0o755);
    const directory = path.join(root, "body"); fs.mkdirSync(directory, { mode: 0o700 });
    const script = fileURLToPath(new URL("../scripts/check-nginx-upload-buffer.sh", import.meta.url));
    const probe = (dir = directory) => spawnSync("sh", [script, "www-data", dir], { encoding: "utf8" });
    assert.notEqual(probe().status, 0);
    const uid = Number(spawnSync("id", ["-u", "www-data"], { encoding: "utf8" }).stdout.trim());
    const gid = Number(spawnSync("id", ["-g", "www-data"], { encoding: "utf8" }).stdout.trim());
    fs.chownSync(directory, uid, gid);
    assert.equal(probe().status, 0);
    assert.deepEqual(fs.readdirSync(directory), []);
    const link = path.join(root, "link"); fs.symlinkSync(directory, link);
    assert.notEqual(probe(link).status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
