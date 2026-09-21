# Mobile voice upload recovery

## Failure boundary

A transcription POST with HTTP 408, approximately 60 seconds of request time,
only a small received request length, and no upstream status indicates that the
reverse proxy did not finish receiving the upload or dispatch it to the app.
It does not identify the underlying client/network cause, and does not prove
that a transcription provider or API credential failed.

## Client change

`src/voice-upload.ts` reads the actual audio bytes before opening HTTP, with a
15-second read deadline and the existing 15 MiB audio limit. It checks that the
read byte count matches the Blob size. It then builds an in-memory multipart
ArrayBuffer and sends those bytes with XMLHttpRequest. Neither a restored Blob
nor a File is handed to the native multipart upload implementation.

The endpoint, six form fields, MIME types, same-origin login cookies and CSRF
header remain compatible with the existing transcription route. No server
schema, API key, provider, base path or proxy timeout changes are required.

The composer shows reading, uploading (real byte progress), and recognizing as
separate phases. Upload progress measures browser transmission, not a server
acknowledgement. A 45-second upload inactivity timer and a five-minute total
request timer bound stalled requests. Only byte advancement resets the upload
watchdog, and completing the upload clears that watchdog. There is no automatic
resubmission. Manual retries keep the original recording ID, conversation and
draft text; concurrent retry clicks cannot create multiple active submissions.

Failures do not delete or replace the source audio draft. A malformed HTTP 200
response is a failure, not permission to delete the draft. Unsent drafts remain
until successful recognition or explicit deletion. Audio whose browser storage is already
unreadable cannot be reconstructed by this change; it reports a read error.

## Validation and rollout

Run from the checkout containing this change:

```sh
npm run lint
node --import tsx --test tests/voice-upload.test.ts
npm test
```

The focused tests include actual multipart parsing of binary audio, Unicode
context, all six form fields and unchanged retry identity. XHR state/error tests
use a fake transport and are not evidence of iPhone compatibility.

Review only these files when transferring the fix to another deployed version:

- `src/voice-upload.ts` (new)
- `src/api.ts` (transcription transport only; retain the destination BASE_PATH)
- `src/conversation/useVoiceInput.ts`
- `src/conversation/ConversationVoiceInput.tsx`
- `tests/voice-upload.test.ts` (new)
- this document

Do not replace an entire checkout or publish an unrelated local build. Compare
the deployed source, preserve unrelated changes, and retain the prior release
for rollback. The new client is compatible with the existing API; build and
publish it through the destination's verified deployment process.

Phone acceptance must cover a new recording, retry of a retained recording,
and restoring a recording after reload, on mobile data. Keep the page foreground
during this test. Verify complete upload reaches the backend and real recognition
returns text. Repeating a recording ID must not produce duplicate execution.
Do not clear browser storage or discard the user's failed recording to test this.

After acceptance, remove temporary diagnostic logging using the verified site
backup, test the proxy configuration, and reload it. If the site configuration
has changed since the backup, remove only diagnostic directives instead of
overwriting those newer changes. Never log audio, transcript text, cookies,
authorization headers, or signed audio URLs.

## Follow-up: upstream recognition and multiple retained recordings

A complete upload followed by HTTP 503 is a separate failure from an upload-body
timeout. The recognition service now sends audio inline instead of requiring the
provider to fetch a temporary public URL. WAV payloads over 512 KiB are compressed
to mono 16 kHz / 64 kbps MP3. The encoded input stays under the provider's base64
limit; the existing overall recognition deadline replaces the premature 30-second
attempt cutoff. Transcription explicitly disables model thinking.

The composer restores all retained recordings, allows new recordings without
discarding older ones, and exposes a switch control when several drafts remain.
Only the successful recording (or an explicitly deleted recording) is removed.
Opening the composer no longer automatically purges unsent recordings by age.

Additional files: `server/transcription.ts`, `tests/transcription.test.ts`, and
`src/conversation/voice-draft-store.ts`.

Validation: 22 focused transcription/upload/idempotency tests passed. An isolated
Chromium test with real IndexedDB verified aged-draft restoration, recording while
older drafts remain, failure persistence, switching, successful retry, cancellation,
and remount. Two candidate-image calls using public sample speech succeeded.
Mobile acceptance was subsequently reported complete by the operator. On the
isolated publication branch, lint and all 22 focused tests passed. The full test
suite reported 303 passed, 35 failed and 1 skipped on Windows. Failures included
fsync permission errors and missing executable fixtures. An unmodified baseline
was not rerun, so these failures are not all classified as pre-existing and
full-suite success is not claimed.
