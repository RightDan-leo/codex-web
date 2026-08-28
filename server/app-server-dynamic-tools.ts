import crypto from "node:crypto";

export type DynamicToolNamespaceTool = {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading?: boolean;
};

export type DynamicToolSpec = DynamicToolNamespaceTool | {
  type: "namespace";
  name: string;
  description: string;
  tools: DynamicToolNamespaceTool[];
};

export type DynamicToolCallRequest = {
  callId: string;
  threadId: string;
  turnId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
};

export type DynamicToolExecutionResult =
  | { success: true; value: unknown }
  | { success: false; error: string };

export type DynamicToolHandler = (
  call: DynamicToolCallRequest,
) => Promise<DynamicToolExecutionResult> | DynamicToolExecutionResult;

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_TOOL_PAYLOAD_BYTES = 256 * 1024;

export function isDynamicToolCallRequest(value: unknown): value is DynamicToolCallRequest {
  if (!isObject(value)) return false;
  if (!CALL_ID.test(String(value.callId ?? "")) || !CALL_ID.test(String(value.threadId ?? "")) || !CALL_ID.test(String(value.turnId ?? ""))) {
    return false;
  }
  if (value.namespace !== null && value.namespace !== undefined && !TOOL_NAME.test(String(value.namespace))) return false;
  if (!TOOL_NAME.test(String(value.tool ?? ""))) return false;
  return jsonByteLength(value.arguments) <= MAX_TOOL_PAYLOAD_BYTES;
}

export function isDynamicToolExecutionResult(value: unknown): value is DynamicToolExecutionResult {
  if (!isObject(value) || typeof value.success !== "boolean") return false;
  if (value.success) return Object.hasOwn(value, "value") && jsonByteLength(value.value) <= MAX_TOOL_PAYLOAD_BYTES;
  return typeof value.error === "string" && value.error.length > 0 && value.error.length <= 2_000;
}

export function validateDynamicToolSpecs(value: unknown): value is DynamicToolSpec[] {
  if (!Array.isArray(value) || value.length > 16 || jsonByteLength(value) > MAX_TOOL_PAYLOAD_BYTES) return false;
  return value.every((spec) => {
    if (!isObject(spec) || !TOOL_NAME.test(String(spec.name ?? "")) || typeof spec.description !== "string") return false;
    if (spec.type === "function") return isObject(spec.inputSchema);
    if (spec.type !== "namespace" || !Array.isArray(spec.tools) || spec.tools.length > 32) return false;
    return spec.tools.every((tool) => isObject(tool)
      && tool.type === "function"
      && TOOL_NAME.test(String(tool.name ?? ""))
      && typeof tool.description === "string"
      && isObject(tool.inputSchema));
  });
}

/**
 * Dynamic tools are fixed when an App Server thread is created. Persisting a
 * fingerprint lets callers distinguish a compatible thread from a legacy one
 * that must be replaced before tools can be used.
 */
export function dynamicToolsetFingerprint(specs: DynamicToolSpec[] | undefined): string | null {
  if (!specs?.length) return null;
  return crypto.createHash("sha256").update(JSON.stringify(specs), "utf8").digest("hex");
}

export function planDynamicToolThread(
  threadId: string | null,
  persistedToolset: string | null | undefined,
  specs: DynamicToolSpec[] | undefined,
): {
  threadId: string | null;
  dynamicTools: DynamicToolSpec[] | undefined;
  desiredToolset: string | null;
  migratesLegacyThread: boolean;
} {
  const desiredToolset = dynamicToolsetFingerprint(specs);
  const migratesLegacyThread = Boolean(desiredToolset && threadId && persistedToolset !== desiredToolset);
  return {
    threadId: migratesLegacyThread ? null : threadId,
    dynamicTools: threadId && !migratesLegacyThread ? undefined : specs,
    desiredToolset,
    migratesLegacyThread,
  };
}

export function dynamicToolResultText(result: DynamicToolExecutionResult): string {
  try {
    return JSON.stringify(result.success ? result.value : { error: result.error });
  } catch {
    return JSON.stringify({ error: "工具返回了无法序列化的结果。" });
  }
}

export function dynamicToolFailure(error: unknown): DynamicToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error || "智能看板操作失败。");
  return { success: false, error: message.trim().slice(0, 2_000) || "智能看板操作失败。" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonByteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { return Number.POSITIVE_INFINITY; }
}
