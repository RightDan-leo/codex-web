import assert from "node:assert/strict";
import test from "node:test";
import { requireCompatibleRemoteCodexVersion } from "../server/remote-codex-version.js";

test("remote worker rejects missing and older Codex app-server protocols", () => {
  assert.throws(() => requireCompatibleRemoteCodexVersion(undefined), /Unable to verify/);
  assert.throws(() => requireCompatibleRemoteCodexVersion("codex-cli 0.142.5"), /0\.144\.1 or newer/);
  assert.equal(requireCompatibleRemoteCodexVersion("codex-cli 0.144.1"), "codex-cli 0.144.1");
  assert.equal(requireCompatibleRemoteCodexVersion("codex-cli 0.150.0"), "codex-cli 0.150.0");
});
