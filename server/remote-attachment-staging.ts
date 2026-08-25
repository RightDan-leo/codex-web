import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REMOTE_ATTACHMENT_MAX_BYTES,
  REMOTE_ATTACHMENT_MAX_FILES,
  REMOTE_ATTACHMENT_TOTAL_MAX_BYTES,
  type RemoteAttachmentPayload,
} from "./remote-worker-protocol.js";

const REMOTE_RUNTIME_DIRECTORY = "codex-web-remote-worker";
const DEFAULT_STALE_RUNTIME_AGE_MS = 24 * 60 * 60 * 1000;

export type StagedRemoteAttachment = {
  name: string;
  mimeType: string;
  size: number;
  absolutePath: string;
};

export type StagedRemoteJob = {
  prompt: string;
  runtimeRoot?: string;
  imagePaths: string[];
  attachments: StagedRemoteAttachment[];
  cleanup(): void;
};

/** Remove orphaned job directories left by a worker or machine crash. */
export function pruneStaleRemoteAttachmentRuntimes(
  maxAgeMs = DEFAULT_STALE_RUNTIME_AGE_MS,
  now = Date.now(),
): number {
  const baseRoot = remoteRuntimeBaseRoot();
  let removed = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(baseRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const deadline = now - Math.max(60_000, maxAgeMs);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(baseRoot, entry.name);
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || stat.mtimeMs > deadline) continue;
      fs.rmSync(absolute, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A concurrently finishing job may disappear between listing and stat.
    }
  }
  return removed;
}

/**
 * Materialize bounded wire attachments in a worker-owned temporary directory.
 * The directory is outside the real project, explicitly exposed to the Codex
 * sandbox for this turn, and recursively removed after completion/cancellation.
 */
export function stageRemoteAttachments(
  jobId: string,
  prompt: string,
  attachments: RemoteAttachmentPayload[] = [],
): StagedRemoteJob {
  if (attachments.length === 0) {
    return { prompt, imagePaths: [], attachments: [], cleanup: () => {} };
  }
  if (attachments.length > REMOTE_ATTACHMENT_MAX_FILES) throw new Error("Too many remote attachments");

  const baseRoot = remoteRuntimeBaseRoot();
  fs.mkdirSync(baseRoot, { recursive: true, mode: 0o700 });
  const safeJobId = jobId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "job";
  const runtimeRoot = fs.mkdtempSync(path.join(baseRoot, `${safeJobId}-`));
  fs.chmodSync(runtimeRoot, 0o700);
  const uploadRoot = path.join(runtimeRoot, "uploads");
  fs.mkdirSync(uploadRoot, { mode: 0o700 });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  };

  try {
    let totalBytes = 0;
    const staged: StagedRemoteAttachment[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > REMOTE_ATTACHMENT_MAX_BYTES) {
        throw new Error("Remote attachment exceeds the per-file limit");
      }
      totalBytes += attachment.size;
      if (totalBytes > REMOTE_ATTACHMENT_TOTAL_MAX_BYTES) throw new Error("Remote attachments exceed the total size limit");

      const content = Buffer.from(attachment.contentBase64, "base64");
      if (content.byteLength !== attachment.size) throw new Error(`Remote attachment size mismatch: ${attachment.name}`);
      const digest = crypto.createHash("sha256").update(content).digest("hex");
      if (!sameDigest(digest, attachment.sha256)) throw new Error(`Remote attachment digest mismatch: ${attachment.name}`);

      const diskName = `${String(index + 1).padStart(2, "0")}-${safeFileName(attachment.name, index)}`;
      const absolutePath = path.join(uploadRoot, diskName);
      fs.writeFileSync(absolutePath, content, { flag: "wx", mode: 0o600 });
      staged.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        absolutePath,
      });
    }

    const imagePaths = staged
      .filter((attachment) => /^image\/(?:png|jpeg|webp)$/i.test(attachment.mimeType))
      .map((attachment) => attachment.absolutePath);
    return {
      prompt: appendAttachmentManifest(prompt, staged),
      runtimeRoot,
      imagePaths,
      attachments: staged,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function remoteRuntimeBaseRoot(): string {
  return path.join(os.tmpdir(), REMOTE_RUNTIME_DIRECTORY);
}

function safeFileName(value: string, index: number): string {
  const normalized = value.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  const compact = normalized.replace(/\s+/g, " ").slice(0, 160);
  return compact || `attachment-${index + 1}`;
}

function sameDigest(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expected)) return false;
  const left = Buffer.from(actual.toLowerCase(), "hex");
  const right = Buffer.from(expected.toLowerCase(), "hex");
  return left.byteLength === right.byteLength && crypto.timingSafeEqual(left, right);
}

function appendAttachmentManifest(prompt: string, attachments: StagedRemoteAttachment[]): string {
  const lines = attachments.map((attachment) => {
    return `- ${JSON.stringify(attachment.absolutePath)} (${attachment.mimeType}, ${attachment.size} bytes; original name: ${JSON.stringify(attachment.name)})`;
  });
  return `${prompt}\n\n[Codex Web remote attachments]\nThe following files were copied into a disposable worker-owned directory for this turn:\n${lines.join("\n")}\nRead them from the exact paths above. This temporary directory is deleted when the task ends. Copy any file that must persist into the registered project before finishing. Do not treat the temporary paths as final deliverables.`;
}
