export const REMOTE_WORKER_PROTOCOL_VERSION = 1 as const;

export const REMOTE_ATTACHMENT_MAX_FILES = 12;
export const REMOTE_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
export const REMOTE_ATTACHMENT_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
export const REMOTE_PROMPT_MAX_CHARS = 100_000;
export const REMOTE_PROGRESS_MAX_BYTES = 64 * 1024;
export const REMOTE_PROGRESS_MAX_EVENTS = 1_000;
export const REMOTE_RESULT_MAX_BYTES = 512 * 1024;
export const REMOTE_ERROR_MAX_CHARS = 8_000;

export type RemoteWorkerPlatform = "linux" | "darwin" | "win32";

export type RemoteWorkerProjectDescriptor = {
  id: string;
  name: string;
};

export type RemoteWorkerCapabilities = {
  platform: RemoteWorkerPlatform;
  arch: string;
  codexVersion?: string;
  supportsSteering: boolean;
  supportsInterrupt: boolean;
  /** Optional for compatibility with workers built before attachment staging. */
  supportsAttachments?: boolean;
};

export type RemoteAttachmentPayload = {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  contentBase64: string;
};

export type WorkerHelloMessage = {
  type: "worker.hello";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  workerId: string;
  displayName: string;
  capabilities: RemoteWorkerCapabilities;
  projects: RemoteWorkerProjectDescriptor[];
};

export type ServerRunMessage = {
  type: "server.run";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
  jobId: string;
  projectId: string;
  prompt: string;
  codexThreadId?: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: RemoteAttachmentPayload[];
};

export type ServerSteerMessage = {
  type: "server.steer";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
  jobId: string;
  prompt: string;
};

export type ServerCancelMessage = {
  type: "server.cancel";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
  jobId: string;
};

export type ServerPingMessage = {
  type: "server.ping";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
};

export type ServerToWorkerMessage = ServerRunMessage | ServerSteerMessage | ServerCancelMessage | ServerPingMessage;

export type WorkerReadyMessage = {
  type: "worker.ready";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  workerId: string;
};

export type WorkerThreadStartedMessage = {
  type: "worker.thread.started";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
  jobId: string;
  threadId: string;
};

export type WorkerProgressMessage = {
  type: "worker.progress";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
  jobId: string;
  payload: unknown;
};

export type WorkerSteeredMessage = {
  type: "worker.steered";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
  jobId: string;
  turnId?: string;
};

export type WorkerResultMessage = {
  type: "worker.result";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
  jobId: string;
  result: string;
};

export type WorkerErrorMessage = {
  type: "worker.error";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
  jobId?: string;
  message: string;
};

export type WorkerCancelledMessage = {
  type: "worker.cancelled";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
  jobId: string;
};

export type WorkerPongMessage = {
  type: "worker.pong";
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  requestId: string;
};

export type WorkerToServerMessage =
  | WorkerReadyMessage
  | WorkerThreadStartedMessage
  | WorkerProgressMessage
  | WorkerSteeredMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerCancelledMessage
  | WorkerPongMessage;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/i;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function hasCurrentVersion(value: Record<string, unknown>): boolean {
  return value.protocolVersion === REMOTE_WORKER_PROTOCOL_VERSION;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error(`Unexpected field in ${label}`);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function jsonByteLength(value: unknown): number {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new Error("Remote progress payload must be JSON serializable"); }
  if (serialized === undefined) throw new Error("Remote progress payload must be JSON serializable");
  return Buffer.byteLength(serialized, "utf8");
}

function validateAttachments(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > REMOTE_ATTACHMENT_MAX_FILES) {
    throw new Error("Invalid remote attachment list");
  }
  let totalBytes = 0;
  for (const attachment of value) {
    if (!isObject(attachment)) throw new Error("Invalid remote attachment");
    assertOnlyKeys(attachment, ["name", "mimeType", "size", "sha256", "contentBase64"], "remote attachment");
    if (typeof attachment.name !== "string" || !attachment.name.trim() || attachment.name.length > 180 || /[\u0000\r\n]/.test(attachment.name)) {
      throw new Error("Invalid remote attachment name");
    }
    if (typeof attachment.mimeType !== "string" || !attachment.mimeType.trim() || attachment.mimeType.length > 255) {
      throw new Error("Invalid remote attachment MIME type");
    }
    if (!Number.isSafeInteger(attachment.size) || Number(attachment.size) < 0 || Number(attachment.size) > REMOTE_ATTACHMENT_MAX_BYTES) {
      throw new Error("Remote attachment exceeds the per-file limit");
    }
    if (typeof attachment.sha256 !== "string" || !SHA256_HEX.test(attachment.sha256)) {
      throw new Error("Invalid remote attachment digest");
    }
    if (typeof attachment.contentBase64 !== "string" || !STRICT_BASE64.test(attachment.contentBase64)) {
      throw new Error("Invalid remote attachment encoding");
    }
    const decodedBytes = Buffer.byteLength(attachment.contentBase64, "base64");
    if (decodedBytes !== attachment.size) throw new Error("Remote attachment size does not match its payload");
    totalBytes += decodedBytes;
    if (totalBytes > REMOTE_ATTACHMENT_TOTAL_MAX_BYTES) throw new Error("Remote attachments exceed the total size limit");
  }
}

export function validateWorkerHello(value: unknown): WorkerHelloMessage {
  if (!isObject(value) || value.type !== "worker.hello" || !hasCurrentVersion(value)) {
    throw new Error("Invalid remote worker hello message");
  }
  assertOnlyKeys(value, ["type", "protocolVersion", "workerId", "displayName", "capabilities", "projects"], "remote worker hello");
  if (!isSafeId(value.workerId) || !boundedString(value.displayName, 160) || !value.displayName.trim()) {
    throw new Error("Invalid remote worker identity");
  }
  if (!isObject(value.capabilities)) throw new Error("Invalid remote worker capabilities");
  assertOnlyKeys(value.capabilities, ["platform", "arch", "codexVersion", "supportsSteering", "supportsInterrupt", "supportsAttachments"], "remote worker capabilities");
  const platform = value.capabilities.platform;
  if (!(["linux", "darwin", "win32"] as unknown[]).includes(platform)) throw new Error("Invalid remote worker platform");
  if (!boundedString(value.capabilities.arch, 64) || !value.capabilities.arch) throw new Error("Invalid remote worker architecture");
  if (typeof value.capabilities.supportsSteering !== "boolean" || typeof value.capabilities.supportsInterrupt !== "boolean") {
    throw new Error("Invalid remote worker capability flags");
  }
  if (value.capabilities.supportsAttachments !== undefined && typeof value.capabilities.supportsAttachments !== "boolean") {
    throw new Error("Invalid remote worker attachment capability");
  }
  if (value.capabilities.codexVersion !== undefined && !boundedString(value.capabilities.codexVersion, 160)) {
    throw new Error("Invalid remote worker Codex version");
  }
  if (!Array.isArray(value.projects) || value.projects.length > 128) throw new Error("Invalid remote worker project list");
  const seen = new Set<string>();
  for (const project of value.projects) {
    if (!isObject(project)) throw new Error("Invalid remote worker project");
    assertOnlyKeys(project, ["id", "name"], "remote worker project");
    if (!isSafeId(project.id) || !boundedString(project.name, 160) || !project.name.trim()) {
      throw new Error("Invalid remote worker project");
    }
    if (seen.has(project.id)) throw new Error("Duplicate remote worker project id");
    seen.add(project.id);
  }
  return value as WorkerHelloMessage;
}

export function validateServerMessage(value: unknown): ServerToWorkerMessage {
  if (!isObject(value) || !hasCurrentVersion(value) || typeof value.type !== "string") {
    throw new Error("Invalid remote worker server message");
  }
  if (!isSafeId(value.requestId)) throw new Error("Invalid remote worker request id");
  switch (value.type) {
    case "server.run":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId", "jobId", "projectId", "prompt", "codexThreadId", "model", "reasoningEffort", "attachments"], "remote run request");
      if (!isSafeId(value.jobId) || !isSafeId(value.projectId) || !boundedString(value.prompt, REMOTE_PROMPT_MAX_CHARS) || !value.prompt.trim()) {
        throw new Error("Invalid remote run request");
      }
      if (value.codexThreadId !== undefined && !isSafeId(value.codexThreadId)) throw new Error("Invalid remote Codex thread id");
      if (value.model !== undefined && (!boundedString(value.model, 160) || !value.model.trim())) throw new Error("Invalid remote model");
      if (value.reasoningEffort !== undefined && (!boundedString(value.reasoningEffort, 64) || !value.reasoningEffort.trim())) throw new Error("Invalid reasoning effort");
      validateAttachments(value.attachments);
      return value as ServerRunMessage;
    case "server.steer":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId", "jobId", "prompt"], "remote steer request");
      if (!isSafeId(value.jobId) || !boundedString(value.prompt, REMOTE_PROMPT_MAX_CHARS) || !value.prompt.trim()) throw new Error("Invalid remote steer request");
      return value as ServerSteerMessage;
    case "server.cancel":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId", "jobId"], "remote cancel request");
      if (!isSafeId(value.jobId)) throw new Error("Invalid remote cancel request");
      return value as ServerCancelMessage;
    case "server.ping":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId"], "remote ping request");
      return value as ServerPingMessage;
    default:
      throw new Error("Unknown remote worker server message");
  }
}

export function validateWorkerMessage(value: unknown): WorkerToServerMessage {
  if (!isObject(value) || !hasCurrentVersion(value) || typeof value.type !== "string") {
    throw new Error("Invalid remote worker message");
  }
  if (value.type === "worker.ready") {
    assertOnlyKeys(value, ["type", "protocolVersion", "workerId"], "remote worker ready message");
    if (!isSafeId(value.workerId)) throw new Error("Invalid ready worker id");
    return value as WorkerReadyMessage;
  }
  if (!isSafeId(value.requestId)) throw new Error("Invalid remote worker request id");
  switch (value.type) {
    case "worker.thread.started":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId", "jobId", "threadId"], "remote thread event");
      if (!isSafeId(value.jobId) || !isSafeId(value.threadId)) throw new Error("Invalid remote thread event");
      return value as WorkerThreadStartedMessage;
    case "worker.progress":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId", "jobId", "payload"], "remote progress event");
      if (!isSafeId(value.jobId)) throw new Error("Invalid remote progress event");
      if (jsonByteLength(value.payload) > REMOTE_PROGRESS_MAX_BYTES) throw new Error("Remote progress payload exceeds the size limit");
      return value as WorkerProgressMessage;
    case "worker.steered":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId", "jobId", "turnId"], "remote steer acknowledgement");
      if (!isSafeId(value.jobId)) throw new Error("Invalid remote steer acknowledgement");
      if (value.turnId !== undefined && !isSafeId(value.turnId)) throw new Error("Invalid remote steered turn id");
      return value as WorkerSteeredMessage;
    case "worker.result":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId", "jobId", "result"], "remote result event");
      if (!isSafeId(value.jobId) || typeof value.result !== "string" || Buffer.byteLength(value.result, "utf8") > REMOTE_RESULT_MAX_BYTES) throw new Error("Invalid remote result event");
      return value as WorkerResultMessage;
    case "worker.error":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId", "jobId", "message"], "remote error event");
      if (value.jobId !== undefined && !isSafeId(value.jobId)) throw new Error("Invalid remote error job id");
      if (!boundedString(value.message, REMOTE_ERROR_MAX_CHARS) || !value.message) throw new Error("Invalid remote error event");
      return value as WorkerErrorMessage;
    case "worker.cancelled":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId", "jobId"], "remote cancellation event");
      if (!isSafeId(value.jobId)) throw new Error("Invalid remote cancellation event");
      return value as WorkerCancelledMessage;
    case "worker.pong":
      assertOnlyKeys(value, ["type", "protocolVersion", "requestId"], "remote pong message");
      return value as WorkerPongMessage;
    default:
      throw new Error("Unknown remote worker message");
  }
}
