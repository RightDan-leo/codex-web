import fs from "node:fs";
import path from "node:path";
import type { RemoteWorkerProject } from "./remote-worker-runtime.js";

export type RemoteWorkerClientConfig = {
  serverUrl: string;
  workerId: string;
  displayName: string;
  defaultModel: string;
  defaultReasoningEffort: string;
  codexExecutablePath?: string;
  projects: RemoteWorkerProject[];
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Remote worker config must be a JSON object");
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Remote worker config requires ${key}`);
  return value.trim();
}

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("Remote worker serverUrl must use HTTPS, except for localhost development");
  if (url.username || url.password || url.search || url.hash) throw new Error("Remote worker serverUrl must not contain credentials, query, or hash");
  return url.toString().replace(/\/$/, "");
}

function existingDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`${label} does not exist or is not a directory: ${resolved}`);
  return resolved;
}

export function loadRemoteWorkerConfig(configPath: string): RemoteWorkerClientConfig {
  const absoluteConfigPath = path.resolve(configPath);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(absoluteConfigPath, "utf8")); }
  catch (error) { throw new Error(`Unable to read remote worker config ${absoluteConfigPath}: ${error instanceof Error ? error.message : String(error)}`); }
  const record = objectValue(parsed);
  const workerId = requiredString(record, "workerId");
  if (!SAFE_ID.test(workerId)) throw new Error("Remote worker workerId contains unsupported characters");
  const displayName = requiredString(record, "displayName");
  const defaultModel = requiredString(record, "defaultModel");
  const defaultReasoningEffort = requiredString(record, "defaultReasoningEffort");
  const serverUrl = normalizeServerUrl(requiredString(record, "serverUrl"));
  const codexExecutablePath = typeof record.codexExecutablePath === "string" && record.codexExecutablePath.trim()
    ? path.resolve(record.codexExecutablePath.trim())
    : undefined;

  if (!Array.isArray(record.projects) || record.projects.length === 0 || record.projects.length > 128) {
    throw new Error("Remote worker config requires between 1 and 128 projects");
  }
  const seen = new Set<string>();
  const projects = record.projects.map((rawProject, index): RemoteWorkerProject => {
    const project = objectValue(rawProject);
    const id = requiredString(project, "id");
    if (!SAFE_ID.test(id)) throw new Error(`Remote worker project ${index + 1} has an invalid id`);
    if (seen.has(id)) throw new Error(`Duplicate remote worker project id: ${id}`);
    seen.add(id);
    const name = requiredString(project, "name");
    const cwd = existingDirectory(requiredString(project, "cwd"), `Remote worker project ${id} cwd`);
    const codexHome = typeof project.codexHome === "string" && project.codexHome.trim()
      ? existingDirectory(project.codexHome.trim(), `Remote worker project ${id} CODEX_HOME`)
      : undefined;
    return { id, name, cwd, ...(codexHome ? { codexHome } : {}) };
  });

  return {
    serverUrl,
    workerId,
    displayName,
    defaultModel,
    defaultReasoningEffort,
    ...(codexExecutablePath ? { codexExecutablePath } : {}),
    projects,
  };
}
