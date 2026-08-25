import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FileRow } from "../server/db.js";
import { buildRemoteAttachmentPayloads } from "../server/remote-attachment-payload.js";
import { REMOTE_ATTACHMENT_MAX_FILES } from "../server/remote-worker-protocol.js";

function uploadRow(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: "file-1",
    conversation_id: "conversation-1",
    message_id: "message-1",
    pending_prompt_id: null,
    composer_draft_id: null,
    original_name: "说明.txt",
    relative_path: "uploads/source.txt",
    mime_type: "text/plain",
    size: 0,
    kind: "upload",
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

test("server builds a path-free attachment payload with size and digest", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-payload-"));
  try {
    fs.mkdirSync(path.join(workspace, "uploads"));
    const content = Buffer.from("remote attachment content", "utf8");
    fs.writeFileSync(path.join(workspace, "uploads", "source.txt"), content);
    const [payload] = await buildRemoteAttachmentPayloads(workspace, [uploadRow({ size: content.byteLength })]);
    assert.equal(payload.name, "说明.txt");
    assert.equal(payload.mimeType, "text/plain");
    assert.equal(payload.size, content.byteLength);
    assert.equal(Buffer.from(payload.contentBase64, "base64").toString("utf8"), content.toString("utf8"));
    assert.equal(payload.sha256, crypto.createHash("sha256").update(content).digest("hex"));
    assert.equal(JSON.stringify(payload).includes(workspace), false);
    assert.equal("relative_path" in payload, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("server rejects attachment path escape and metadata races", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-payload-"));
  const workspace = path.join(parent, "conversation");
  try {
    fs.mkdirSync(path.join(workspace, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(parent, "secret.txt"), "secret");
    await assert.rejects(
      buildRemoteAttachmentPayloads(workspace, [uploadRow({ relative_path: "../secret.txt", size: 6 })]),
      /escapes workspace/,
    );

    fs.writeFileSync(path.join(workspace, "uploads", "source.txt"), "changed");
    await assert.rejects(
      buildRemoteAttachmentPayloads(workspace, [uploadRow({ size: 1 })]),
      /发生变化/,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("server enforces the remote attachment count before reading files", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cww-remote-payload-"));
  try {
    const rows = Array.from({ length: REMOTE_ATTACHMENT_MAX_FILES + 1 }, (_, index) => uploadRow({
      id: `file-${index}`,
      original_name: `file-${index}.txt`,
      relative_path: `uploads/file-${index}.txt`,
    }));
    await assert.rejects(buildRemoteAttachmentPayloads(workspace, rows), /最多支持/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
