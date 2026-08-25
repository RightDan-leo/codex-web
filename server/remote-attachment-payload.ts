import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FileRow } from "./db.js";
import { resolveInside } from "./paths.js";
import {
  REMOTE_ATTACHMENT_MAX_BYTES,
  REMOTE_ATTACHMENT_MAX_FILES,
  REMOTE_ATTACHMENT_TOTAL_MAX_BYTES,
  type RemoteAttachmentPayload,
} from "./remote-worker-protocol.js";

/**
 * Read conversation uploads into the bounded, path-free wire format used by a
 * trusted Remote Worker. Absolute server paths never leave this function.
 */
export async function buildRemoteAttachmentPayloads(
  workspace: string,
  uploads: FileRow[],
): Promise<RemoteAttachmentPayload[]> {
  if (uploads.length > REMOTE_ATTACHMENT_MAX_FILES) {
    throw new Error(`远端任务最多支持 ${REMOTE_ATTACHMENT_MAX_FILES} 个附件`);
  }

  const payloads: RemoteAttachmentPayload[] = [];
  let totalBytes = 0;
  for (let index = 0; index < uploads.length; index += 1) {
    const file = uploads[index];
    if (file.kind !== "upload") throw new Error("远端任务只允许传输用户上传的附件");
    const absolute = resolveInside(workspace, file.relative_path);
    const source = await openRegularFileWithoutSymlinks(absolute, file.original_name);
    try {
      const stat = await source.stat();
      if (!stat.isFile()) throw new Error(`附件不是普通文件：${file.original_name}`);
      if (stat.size !== file.size) throw new Error(`附件在发送前发生变化：${file.original_name}`);
      if (stat.size > REMOTE_ATTACHMENT_MAX_BYTES) {
        throw new Error(`附件超过远端单文件上限（8 MiB）：${file.original_name}`);
      }
      totalBytes += stat.size;
      if (totalBytes > REMOTE_ATTACHMENT_TOTAL_MAX_BYTES) {
        throw new Error("远端附件总大小超过 16 MiB 上限");
      }

      const content = await source.readFile();
      if (content.byteLength !== stat.size) throw new Error(`附件读取不完整：${file.original_name}`);
      payloads.push({
        name: portableAttachmentName(file.original_name, index),
        mimeType: normalizedMimeType(file.mime_type),
        size: content.byteLength,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        contentBase64: content.toString("base64"),
      });
    } finally {
      await source.close();
    }
  }
  return payloads;
}

async function openRegularFileWithoutSymlinks(absolute: string, displayName: string): Promise<fs.promises.FileHandle> {
  const linkStat = await fs.promises.lstat(absolute);
  if (linkStat.isSymbolicLink()) throw new Error(`远端附件不能是符号链接：${displayName}`);
  try {
    return await fs.promises.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`远端附件不能是符号链接：${displayName}`);
    throw error;
  }
}

function portableAttachmentName(value: string, index: number): string {
  const portable = value.replace(/\\/g, "/");
  const base = path.posix.basename(portable).replace(/[\u0000\r\n]/g, "_").trim();
  return (base || `attachment-${index + 1}`).slice(0, 180);
}

function normalizedMimeType(value: string): string {
  const normalized = value.trim().slice(0, 255);
  return normalized || "application/octet-stream";
}
