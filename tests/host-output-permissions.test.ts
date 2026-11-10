import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import ts from "typescript";

// Exercise the actual event handler without starting the privileged host socket.
const source = fs.readFileSync(new URL("../server/host-root-server.ts", import.meta.url), "utf8");
const start = source.indexOf('  output.on("line",', source.indexOf("function startWorker("));
const end = source.indexOf('  child.on("error",', start);
const helperStart = source.indexOf("function repairWorkspaceOwnership(");
const helperEnd = source.indexOf("\nfunction send(", helperStart);
assert.ok(start >= 0 && end > start && helperEnd > helperStart);
const code = ts.transpileModule(source.slice(helperStart, helperEnd) + "\n" + source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const bind = new Function("output", "worker", "socket", "request", "workspace", "send", "spawnSync", "webUid", "webGid", code);

for (const failure of [undefined, "chown", "chmod"]) {
  test(`terminal publication repairs ownership first; failure=${failure ?? "none"}`, () => {
    const output = new EventEmitter(), worker = { terminal: false }, actions: string[] = [], sent: any[] = [];
    bind(output, worker, {}, { jobId: "fixture" }, "/unused-fixture", (_socket: unknown, msg: any) => {
      actions.push("published"); sent.push(msg.event);
    }, (command: string) => { actions.push(command); return { status: command === failure ? 1 : 0 }; }, 10001, 10001);
    output.emit("line", JSON.stringify({ type: "completed", finalResponse: "report" }));
    assert.deepEqual(actions, failure === "chown" ? ["chown", "published"] : ["chown", "chmod", "published"]);
    assert.equal(sent[0].type, failure ? "failed" : "completed");
    output.emit("line", JSON.stringify({ type: "completed" }));
    assert.equal(sent.length, 1, "duplicate terminal event must not finalize twice");
  });
}

test("web UID can read root-private output at publication, without waiting for child exit", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-publication-"));
  try {
    fs.chmodSync(root, 0o755);
    const workspace = path.join(root, "conversation"); fs.mkdirSync(workspace, { mode: 0o755 });
    const file = path.join(workspace, "result.html.pp-agent.json");
    fs.writeFileSync(file, '{"fixture":true}', { mode: 0o600 });
    const read = () => spawnSync(process.execPath, ["-e", "require('fs').readFileSync(process.argv[1])", file], { uid: 10001, gid: 10001 });
    assert.notEqual(read().status, 0);
    const output = new EventEmitter();
    let published = false;
    bind(output, { terminal: false }, {}, { jobId: "fixture" }, workspace, () => {
      assert.equal(read().status, 0); published = true;
    }, spawnSync, 10001, 10001);
    output.emit("line", JSON.stringify({ type: "completed", finalResponse: "report" }));
    assert.equal(published, true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "do not make output world-readable");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
