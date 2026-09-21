export type VoiceUploadProgress = {
  phase: "reading" | "uploading" | "recognizing";
  percent: number;
};

export class VoiceUploadError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "VoiceUploadError";
  }
}

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const READ_TIMEOUT_MS = 15_000;
const UPLOAD_IDLE_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 300_000;

function readAudio(audio: Blob, timeoutMs: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new VoiceUploadError("读取保留的录音超时，原录音未删除。请重试。")), timeoutMs);
    Promise.resolve().then(() => audio.arrayBuffer()).then(resolve, () => {
      reject(new VoiceUploadError("无法读取录音数据，原录音未删除。请重试，不要清理浏览器数据。"));
    }).finally(() => clearTimeout(timer));
  });
}

// Materialize the actual bytes before opening a request. In particular, do not
// pass a restored, potentially disk-backed Blob/File to the browser's native
// multipart uploader. A Blob's size alone does not prove its bytes are readable.
export async function prepareVoiceMultipart(
  audio: Blob,
  fileName: string,
  fields: Record<string, string>,
  readTimeoutMs = READ_TIMEOUT_MS,
): Promise<{ body: ArrayBuffer; contentType: string }> {
  if (!audio.size) throw new VoiceUploadError("录音数据为空，无法上传。原草稿未删除。");
  if (audio.size > MAX_AUDIO_BYTES) throw new VoiceUploadError("录音超过 15 MB 上传上限，原录音未删除。", 413);
  const bytes = await readAudio(audio, readTimeoutMs);
  if (bytes.byteLength !== audio.size) throw new VoiceUploadError("录音数据不完整，原录音未删除。请重试。");
  const mimeType = audio.type.split(";", 1)[0].trim().toLowerCase();
  if (!/^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac|flac)$/.test(mimeType)) {
    throw new VoiceUploadError("录音格式不受支持，原录音未删除。");
  }
  const boundary = `voice-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const safeName = (value: string) => value.replace(/[\r\n"\\]/g, "_");
  const parts: Uint8Array[] = [encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${safeName(fileName)}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  ), new Uint8Array(bytes)];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(encoder.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${safeName(name)}"\r\n\r\n${value}`));
  }
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return { body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

export function voiceUploadLabel(progress: VoiceUploadProgress | null): string {
  if (progress?.phase === "reading") return "正在读取录音…";
  if (progress?.phase === "uploading") return `正在上传录音 ${progress.percent}%…`;
  return "正在识别语音…";
}

export async function uploadVoice(
  url: string,
  audio: Blob,
  fileName: string,
  fields: Record<string, string>,
  options: {
    csrfToken?: string;
    onProgress?: (progress: VoiceUploadProgress) => void;
    createRequest?: () => XMLHttpRequest;
    uploadIdleTimeoutMs?: number;
    requestTimeoutMs?: number;
  } = {},
): Promise<{ text: string; transcriptionId: string }> {
  options.onProgress?.({ phase: "reading", percent: 0 });
  const multipart = await prepareVoiceMultipart(audio, fileName, fields);
  return new Promise((resolve, reject) => {
    const xhr = options.createRequest?.() ?? new XMLHttpRequest();
    let settled = false;
    let uploaded = false;
    let lastLoaded = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(idleTimer);
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
      xhr.upload.onprogress = xhr.upload.onload = null;
    };
    const fail = (error: VoiceUploadError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      xhr.abort();
    };
    const resetUploadTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new VoiceUploadError("录音上传停滞，尚未收到识别结果。请重试，原录音未删除。")), options.uploadIdleTimeoutMs ?? UPLOAD_IDLE_TIMEOUT_MS);
    };
    try {
      xhr.open("POST", url, true);
      // Same-origin XHR includes the existing login cookie without exposing it.
      xhr.setRequestHeader("Content-Type", multipart.contentType);
      if (options.csrfToken) xhr.setRequestHeader("X-CSRF-Token", options.csrfToken);
      xhr.timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
      xhr.upload.onprogress = (event) => {
        if (settled || uploaded || event.loaded <= lastLoaded) return;
        lastLoaded = event.loaded;
        resetUploadTimer();
        options.onProgress?.({ phase: "uploading", percent: Math.min(99, Math.floor(event.loaded / multipart.body.byteLength * 100)) });
      };
      xhr.upload.onload = () => {
        if (settled) return;
        uploaded = true;
        clearTimeout(idleTimer);
        options.onProgress?.({ phase: "recognizing", percent: 100 });
      };
      xhr.onerror = () => fail(new VoiceUploadError(uploaded
        ? "获取识别结果时连接中断，请重试，原录音未删除。"
        : "录音上传连接中断，请重试，原录音未删除。"));
      xhr.ontimeout = () => fail(new VoiceUploadError(uploaded
        ? "等待语音识别结果超时，请重试，原录音未删除。"
        : "录音上传超时，请重试，原录音未删除。"));
      xhr.onabort = () => fail(new VoiceUploadError("语音请求已中断，原录音未删除。"));
      xhr.onload = () => {
        if (settled) return;
        let result: { error?: unknown; text?: unknown; transcriptionId?: unknown } | null = null;
        try { result = JSON.parse(xhr.responseText); } catch { /* Proxy errors may be HTML. */ }
        if (xhr.status < 200 || xhr.status >= 300) {
          const fallback = xhr.status === 408 ? "录音上传超时，请重试，原录音未删除。"
            : xhr.status === 413 ? "录音超过上传大小限制，原录音未删除。"
            : xhr.status === 401 ? "登录已过期，请重新登录后重试。"
            : `语音请求失败 (${xhr.status})，请重试。`;
          fail(new VoiceUploadError(typeof result?.error === "string" ? result.error : fallback, xhr.status));
          return;
        }
        if (typeof result?.text !== "string" || !result.text.trim() || typeof result.transcriptionId !== "string" || !result.transcriptionId) {
          fail(new VoiceUploadError("服务器未返回有效的识别结果，原录音未删除。请重试。"));
          return;
        }
        settled = true;
        cleanup();
        resolve({ text: result.text, transcriptionId: result.transcriptionId });
      };
      options.onProgress?.({ phase: "uploading", percent: 0 });
      resetUploadTimer();
      xhr.send(multipart.body);
    } catch {
      fail(new VoiceUploadError("无法开始上传录音，原录音未删除。请重试。"));
    }
  });
}
