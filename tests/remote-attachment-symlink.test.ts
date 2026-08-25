import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FileRow } from "../server/db.js";
import { buildRemoteAttachmentPayloads } from "../server/remote-attachment-payload.js";

function row(relativePath: string, originalName: string): FileRow {
  return {
    id: `file-${originalName}`,
    conversation_id: "conversation-symlink",
    message_id: "message-symlink",
    original_name: originalName,
    relative_path: relativePath,
    mime_type: "text/plain",
    size: 6,
    kind: "upload",
    created_at: new Date(0).toISOString(),
  };
}

test("server refuses final and intermediate symlinks outside the conversation workspace", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows symlink creation requires privileges not guaranteed in CI");
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-symlink-"));
  const workspace = path.join(parent, "conversation");
  const uploads = path.join(workspace, "uploads");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(uploads, { recursive: true });
  fs.mkdirSync(outside);
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "secret");
  fs.symlinkSync(secret, path.join(uploads, "linked.txt"));
  fs.symlinkSync(outside, path.join(workspace, "linked-directory"));
  try {
    await assert.rejects(
      buildRemoteAttachmentPayloads(workspace, [row("uploads/linked.txt", "linked.txt")]),
      /符号链接/,
    );
    await assert.rejects(
      buildRemoteAttachmentPayloads(workspace, [row("linked-directory/secret.txt", "secret.txt")]),
      /会话目录外的符号链接/,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
