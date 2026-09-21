import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import multer from "multer";
import request from "supertest";
import { prepareVoiceMultipart, uploadVoice, VoiceUploadError, voiceUploadLabel, type VoiceUploadProgress } from "../src/voice-upload.js";
import { api, ApiError, BASE_PATH, setCsrf } from "../src/api.js";

const audio = () => new Blob([new Uint8Array([0, 1, 127, 128, 255, 13, 10])], { type: "audio/mp4" });
const recordingId = "6a1b6d11-6af0-4de8-83b5-1f8ddf8e5d68";

class FakeRequest {
  upload = { onprogress: null, onload: null } as unknown as XMLHttpRequestUpload;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  timeout = 0;
  status = 200;
  responseText = JSON.stringify({ text: "测试语音", transcriptionId: "transcript-1" });
  headers: Record<string, string> = {};
  method = "";
  url = "";
  aborted = false;
  sent: ArrayBuffer | null = null;
  action: (xhr: FakeRequest) => void = (xhr) => xhr.onload?.();
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: ArrayBuffer) {
    assert.ok(body instanceof ArrayBuffer, "upload must send bytes, never a Blob or native FormData");
    this.sent = body;
    queueMicrotask(() => this.action(this));
  }
  abort() { this.aborted = true; this.onabort?.(); }
  asRequest = () => this as unknown as XMLHttpRequest;
  progress(loaded: number) { this.upload.onprogress?.call(this.upload, { loaded } as ProgressEvent); }
  uploadComplete() { this.upload.onload?.call(this.upload, {} as ProgressEvent); }
}

test("voice bytes round-trip through real multipart parser with all six fields and retry identity", async () => {
  const original = audio();
  const fields = {
    conversationId: "conversation-1", projectId: "", draftText: "原始草稿\r\n保留英文 Codex",
    purpose: "composer", attachmentNames: '["说明.txt"]', clientRecordingId: recordingId,
  };
  const app = express();
  app.post("/transcriptions", multer({ limits: { files: 1, fields: 6, fileSize: 15 * 1024 * 1024 } }).single("audio"), (req, res) => {
    assert.equal(req.file?.mimetype, "audio/mp4");
    assert.equal(req.file?.originalname, "recording.mp4");
    assert.deepEqual(req.file?.buffer, Buffer.from([0, 1, 127, 128, 255, 13, 10]));
    assert.deepEqual({ ...req.body }, fields);
    res.json({ ok: true });
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const payload = await prepareVoiceMultipart(original, "recording.mp4", fields);
    await request(app).post("/transcriptions").set("Content-Type", payload.contentType).send(Buffer.from(payload.body)).expect(200, { ok: true });
  }
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), new Uint8Array([0, 1, 127, 128, 255, 13, 10]));
});

test("empty, oversize, unreadable, truncated and stalled recordings fail before opening HTTP", async () => {
  let opened = 0;
  const options = { createRequest: () => { opened++; return new FakeRequest().asRequest(); } };
  await assert.rejects(uploadVoice("/api/transcriptions", new Blob(), "a.mp4", {}, options), /录音数据为空/);
  await assert.rejects(uploadVoice("/api/transcriptions", { size: 16 * 1024 * 1024 } as Blob, "a.mp4", {}, options), /15 MB/);
  await assert.rejects(uploadVoice("/api/transcriptions", { size: 10, arrayBuffer: async () => { throw new Error("NotReadableError"); } } as Blob, "a.mp4", {}, options), /无法读取录音数据/);
  await assert.rejects(uploadVoice("/api/transcriptions", { size: 10, arrayBuffer: async () => new ArrayBuffer(0) } as Blob, "a.mp4", {}, options), /不完整/);
  await assert.rejects(prepareVoiceMultipart({ size: 10, arrayBuffer: () => new Promise(() => {}) } as Blob, "a.mp4", {}, 5), /读取保留的录音超时/);
  assert.equal(opened, 0);
});

test("serialization removes header injection and preserves Unicode context", async () => {
  const payload = await prepareVoiceMultipart(audio(), 'bad"\r\nInjected: yes.mp4', { draftText: "你好\r\nCodex" });
  const parsed = await new Response(payload.body, { headers: { "Content-Type": payload.contentType } }).formData();
  assert.equal(parsed.get("draftText"), "你好\r\nCodex");
  assert.equal((parsed.get("audio") as File).name, "bad___Injected: yes.mp4");
});

test("upload sends in-memory bytes, CSRF and real staged progress", async () => {
  const xhr = new FakeRequest();
  const phases: VoiceUploadProgress[] = [];
  xhr.action = (current) => {
    current.progress(Math.floor(current.sent!.byteLength / 2));
    current.progress(current.sent!.byteLength);
    current.uploadComplete();
    current.onload?.();
  };
  const result = await uploadVoice("/codex-web/api/transcriptions", audio(), "a.mp4", { clientRecordingId: recordingId }, {
    csrfToken: "test-csrf", onProgress: (progress) => phases.push(progress), createRequest: xhr.asRequest,
  });
  assert.equal(result.text, "测试语音");
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, "/codex-web/api/transcriptions");
  assert.equal(xhr.headers["X-CSRF-Token"], "test-csrf");
  assert.match(xhr.headers["Content-Type"], /^multipart\/form-data; boundary=voice-/);
  assert.deepEqual(phases.map((progress) => progress.phase), ["reading", "uploading", "uploading", "uploading", "recognizing"]);
  assert.equal(phases[3].percent, 99);
  assert.equal(phases[4].percent, 100);
  assert.equal(xhr.aborted, false);
});

test("stalled upload is aborted once without an automatic retry", async () => {
  const xhr = new FakeRequest();
  xhr.action = (current) => current.progress(0);
  let requests = 0;
  await assert.rejects(uploadVoice("/api/transcriptions", audio(), "a.mp4", {}, {
    uploadIdleTimeoutMs: 5,
    createRequest: () => { requests++; return xhr.asRequest(); },
  }), /录音上传停滞/);
  assert.equal(requests, 1);
  assert.equal(xhr.aborted, true);
  assert.equal(xhr.onload, null);
});

test("upload-complete clears the upload watchdog while waiting for recognition", async () => {
  const xhr = new FakeRequest();
  xhr.action = (current) => {
    current.uploadComplete();
    setTimeout(() => current.onload?.(), 20);
  };
  const result = await uploadVoice("/api/transcriptions", audio(), "a.mp4", {}, { createRequest: xhr.asRequest, uploadIdleTimeoutMs: 5 });
  assert.equal(result.transcriptionId, "transcript-1");
  assert.equal(xhr.aborted, false);
});

test("network errors identify upload versus recognition, and never expose Load failed", async () => {
  for (const uploaded of [false, true]) {
    const xhr = new FakeRequest();
    xhr.action = (current) => { if (uploaded) current.uploadComplete(); current.onerror?.(); };
    await assert.rejects(uploadVoice("/api/transcriptions", audio(), "a.mp4", {}, { createRequest: xhr.asRequest }), uploaded ? /获取识别结果时连接中断/ : /录音上传连接中断/);
  }
});

test("timeouts and aborts reject instead of leaving a spinner forever", async () => {
  for (const action of ["ontimeout", "onabort"] as const) {
    const xhr = new FakeRequest();
    xhr.action = (current) => current[action]?.();
    await assert.rejects(uploadVoice("/api/transcriptions", audio(), "a.mp4", {}, { createRequest: xhr.asRequest }), /原录音未删除/);
    assert.equal(xhr.aborted, true);
  }
});

test("proxy HTML errors and malformed successes remain failures, preserving the caller's draft", async () => {
  for (const [status, responseText] of [[408, "<html>408</html>"], [413, ""], [401, ""], [503, '{"error":"稍后重试"}'], [200, "null"], [200, "{}"], [200, "<html>Login</html>"]] as const) {
    const xhr = new FakeRequest();
    xhr.status = status;
    xhr.responseText = responseText;
    await assert.rejects(uploadVoice("/api/transcriptions", audio(), "a.mp4", {}, { createRequest: xhr.asRequest }), VoiceUploadError);
  }
});

test("API integration retains endpoint, CSRF, retry ID, context and ApiError status", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  const xhr = new FakeRequest();
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: function () { return xhr; } });
  setCsrf("integration-csrf");
  try {
    await api.transcribeAudio(audio(), "recording.mp4", { conversationId: "conv", clientRecordingId: recordingId, draftText: "保留草稿" });
    assert.equal(xhr.url, `${BASE_PATH}/api/transcriptions`);
    assert.equal(xhr.headers["X-CSRF-Token"], "integration-csrf");
    const fields = await new Response(xhr.sent!, { headers: { "Content-Type": xhr.headers["Content-Type"] } }).formData();
    assert.equal(fields.get("clientRecordingId"), recordingId);
    assert.equal(fields.get("draftText"), "保留草稿");
    assert.equal(fields.get("conversationId"), "conv");
    xhr.status = 403;
    xhr.responseText = '{"error":"会话校验失败"}';
    await assert.rejects(api.transcribeAudio(audio(), "recording.mp4"), (error) => error instanceof ApiError && error.status === 403 && error.message === "会话校验失败");
  } finally {
    setCsrf();
    if (descriptor) Object.defineProperty(globalThis, "XMLHttpRequest", descriptor);
    else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  }
});

test("voice phase labels do not call a stalled upload recognition", () => {
  assert.equal(voiceUploadLabel({ phase: "reading", percent: 0 }), "正在读取录音…");
  assert.equal(voiceUploadLabel({ phase: "uploading", percent: 42 }), "正在上传录音 42%…");
  assert.equal(voiceUploadLabel({ phase: "recognizing", percent: 100 }), "正在识别语音…");
});
