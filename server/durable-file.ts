import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Windows does not expose POSIX directory fsync through Node. File contents are
// still synced before rename; Linux keeps the directory durability guarantee.
// Do not catch EIO/ENOSPC/EPERM here: real persistence errors must reach callers.
export function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function atomicWriteFile(target: string, content: string | Buffer, mode = 0o660): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, "wx", mode);
    try {
      fs.writeFileSync(descriptor, content, { encoding: "utf8" });
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
    syncDirectory(directory);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
