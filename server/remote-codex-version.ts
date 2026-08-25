export const MINIMUM_REMOTE_CODEX_VERSION = "0.144.1";

export function requireCompatibleRemoteCodexVersion(value: string | undefined): string {
  const detected = value?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!detected) throw new Error("Unable to verify the local Codex CLI version");
  const minimum = MINIMUM_REMOTE_CODEX_VERSION.split(".").map(Number);
  const actual = detected.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return value!;
    if (actual[index] < minimum[index]) {
      throw new Error(`Remote Worker requires Codex CLI ${MINIMUM_REMOTE_CODEX_VERSION} or newer`);
    }
  }
  return value!;
}
