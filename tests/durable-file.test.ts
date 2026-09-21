import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFile, syncDirectory } from "../server/durable-file.js";

test("atomic publication syncs writable file contents and leaves no temporary files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "nested", "memory.md");
  atomicWriteFile(target, "中文记忆\n");
  assert.equal(fs.readFileSync(target, "utf8"), "中文记忆\n");
  atomicWriteFile(target, Buffer.from("updated"));
  assert.equal(fs.readFileSync(target, "utf8"), "updated");
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["memory.md"]);
});

for (const operation of ["fsyncSync", "renameSync"] as const) {
  test(`atomic publication preserves the original and propagates ${operation} failure`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-file-error-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, "memory.md");
    fs.writeFileSync(target, "original");
    const failure = Object.assign(new Error("simulated disk failure"), { code: "EIO" });
    t.mock.method(fs, operation, () => { throw failure; });
    assert.throws(() => atomicWriteFile(target, "replacement"), (error) => error === failure);
    assert.equal(fs.readFileSync(target, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(root), ["memory.md"]);
  });
}

test("directory fsync errors remain visible on POSIX and release the descriptor", {
  skip: process.platform === "win32" ? "Node does not expose POSIX directory fsync on Windows; required in Linux CI" : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let descriptor: number | undefined;
  const failure = Object.assign(new Error("directory sync failed"), { code: "EIO" });
  t.mock.method(fs, "fsyncSync", (fd: number) => { descriptor = fd; throw failure; });
  assert.throws(() => syncDirectory(root), (error) => error === failure);
  assert.notEqual(descriptor, undefined);
  assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
});
