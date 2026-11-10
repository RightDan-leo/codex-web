import assert from "node:assert/strict";
import test from "node:test";
import { recoverableTranscription, type TranscriptReceipt } from "../src/transcription-recovery.js";

const done = { state: "succeeded" as const, text: "saved words", transcriptionId: "saved-id" };
function scenario(receipts: Array<TranscriptReceipt | null | Error>, upload: () => Promise<any>) {
  let ticks = 0, uploads = 0;
  return { run: () => recoverableTranscription({
    read: async () => { const next = receipts.length > 1 ? receipts.shift()! : receipts[0]; if (next instanceof Error) throw next; return next; },
    upload: async () => { uploads++; return upload(); },
    retryable: e => !(e instanceof Error && e.message === "unauthorized"),
    now: () => ticks, wait: async () => { ticks += 1500; },
  }), uploads: () => uploads };
}
test("retry recovers a saved result without uploading or running recognition", async () => {
  const s = scenario([done], async () => { throw new Error("must not upload"); });
  assert.equal((await s.run()).text, done.text); assert.equal(s.uploads(), 0);
});
test("lost upload response is recovered by receipt polling", async () => {
  const s = scenario([null, {state:"processing"}, done], async () => { throw new Error("connection lost"); });
  assert.equal((await s.run()).transcriptionId, done.transcriptionId); assert.equal(s.uploads(), 1);
});
test("202 is followed by short status requests, tolerating a network interruption", async () => {
  const s = scenario([null, new Error("offline"), {state:"processing"}, done], async () => ({state:"processing"}));
  assert.equal((await s.run()).text, done.text); assert.equal(s.uploads(), 1);
});
test("an existing pending receipt is polled without duplicate upload", async () => {
  const s = scenario([{state:"processing"}, done], async () => { throw new Error("must not upload"); });
  assert.equal((await s.run()).text, done.text); assert.equal(s.uploads(), 0);
});
test("provider failures stop polling and retain a retryable error", async () => {
  const s = scenario([null, {state:"failed",error:"provider unavailable"}], async () => ({state:"processing"}));
  await assert.rejects(s.run, /provider unavailable/); assert.equal(s.uploads(), 1);
});
test("missing receipt after failed upload settles without resubmitting", async () => {
  const s = scenario([null], async () => { throw new Error("upload interrupted"); });
  await assert.rejects(s.run, /upload interrupted/); assert.equal(s.uploads(), 1);
});
test("authorization failure is never retried or bypassed", async () => {
  const s = scenario([new Error("unauthorized")], async () => done);
  await assert.rejects(s.run, /unauthorized/); assert.equal(s.uploads(), 0);
});
test("permanent network failure has a bounded wait", async () => {
  const s = scenario([new Error("offline")], async () => { throw new Error("offline"); });
  await assert.rejects(s.run, /暂未取得识别结果/); assert.equal(s.uploads(), 1);
});

test("a malformed saved success cannot clear the retained recording", async () => {
  const s = scenario([{ state: "succeeded", text: "", transcriptionId: "saved" }], async () => done);
  await assert.rejects(s.run, /未返回有效的识别结果/);
  assert.equal(s.uploads(), 0);
});
