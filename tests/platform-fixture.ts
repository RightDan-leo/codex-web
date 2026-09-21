import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";

export const posixOnly = { skip: process.platform === "win32" ? "POSIX mode bits are verified in Linux CI; they do not represent Windows ACLs" : false };
export const linuxIntegration = { skip: process.platform !== "linux" ? "Requires Linux, GNU tar, Unix ownership and executable CLI fixtures; required in Linux CI" : false };
// The shared-auth implementation deliberately relies on flock. A stock Windows
// runner has none; never replace the lock with a no-op just to exercise the test.
export const sharedAuthIntegration = {
  skip: process.platform === "win32" && spawnSync("flock", ["--version"], { timeout: 5_000 }).status !== 0
    ? "Shared auth requires flock; required in Linux CI and tested on Windows when flock is installed"
    : false,
};

export function createTestSymlink(context: TestContext, target: string, link: string, type?: "dir" | "file"): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM" || process.env.REQUIRE_SYMLINK_TESTS === "1") throw error;
    context.skip("Windows symlink privilege unavailable; this security check is required in Linux CI");
    return false;
  }
}
