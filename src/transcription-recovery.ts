export type TranscriptResult = { text: string; transcriptionId: string };
export type TranscriptReceipt =
  | ({ state: "succeeded" } & TranscriptResult)
  | { state: "processing" }
  | { state: "failed"; error: string };

function validResult(result: TranscriptResult): TranscriptResult {
  if (typeof result.text !== "string" || !result.text.trim()
    || typeof result.transcriptionId !== "string" || !result.transcriptionId) {
    throw new Error("服务器未返回有效的识别结果，原录音未删除。请重试。");
  }
  return result;
}

// Recognition survives a lost upload response. Never upload again just to poll.
export async function recoverableTranscription(options: {
  read: () => Promise<TranscriptReceipt | null>;
  upload: () => Promise<TranscriptResult | { state: "processing" }>;
  retryable: (error: unknown) => boolean;
  wait?: () => Promise<void>;
  now?: () => number;
}): Promise<TranscriptResult> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 1500)));
  const read = async () => {
    try { return await options.read(); }
    catch (error) { if (!options.retryable(error)) throw error; return undefined; }
  };
  const before = await read();
  if (before?.state === "succeeded") return validResult(before);
  let uploadError: unknown;
  if (before?.state !== "processing") {
    try {
      const result = await options.upload();
      if ("text" in result) return validResult(result);
    } catch (error) {
      if (!options.retryable(error)) throw error;
      uploadError = error;
    }
  }
  const deadline = now() + 180_000;
  let missing = 0;
  while (now() < deadline) {
    const receipt = await read();
    if (receipt?.state === "succeeded") return validResult(receipt);
    if (receipt?.state === "failed") throw new Error(receipt.error);
    if (receipt === null && ++missing >= 5) {
      throw uploadError ?? new Error("服务器尚未收到这段语音，录音已保留，请重试。");
    }
    if (receipt?.state === "processing") missing = 0;
    await wait();
  }
  throw new Error("暂未取得识别结果，录音已保留；点击重试会先查询已有结果。");
}
