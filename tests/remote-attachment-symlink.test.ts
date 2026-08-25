import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FileRow } from "../server/db.js";
import { buildRemoteAttachmentPayloads } from "../server/remote-attachment-payload.js";

test("server refuses to follow a symlinked upload outside the conversation workspace", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows symlink creation requires privileges not guaranteed in CI");
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-symlink-"));
  const workspace = path.join(parent, "conversation");
  const uploads = path.join(workspace, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const secret = path.join(parent, "secret.txt");
  fs.writeFileSync(secret, "secret");
  fs.symlinkSync(secret, path.join(uploads, "linked.txt"));
  const row: FileRow = {
    id: "file-symlink",
    conversation_id: "conversation-symlink",
    message_id: "message-symlink",
    original_name: "linked.txt",
    relative_path: "uploads/linked.txt",
    mime_type: "text/plain",
    size: 6,
    kind: "upload",
    created_at: new Date(0).toISOString(),
  };
  try {
    await assert.rejects(buildRemoteAttachmentPayloads(workspace, [row]), /符号链接/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
