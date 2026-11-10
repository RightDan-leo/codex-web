# Output and upload recovery validation

This change carries three targeted fixes onto the public main baseline:

- Repair host workspace ownership before publishing a completed/failed event.
  If repair fails, report failure and preserve files; do not publish success.
  Keep the existing exit-time repair and separate web/tenant identities.
- Acknowledge transcription uploads promptly, then recover account-scoped
  results through bounded GET polling. Retain byte-based mobile uploads,
  CSRF, audio identity checks, existing records and unsent drafts.
- Use a dedicated Nginx client-body buffer with a worker-identity write check.
  See `UPLOAD_BUFFER_PERMISSIONS.md`; do not copy private site configurations.

## Checks

Verified on 2026-11-10 against public main baseline `df0028e`, using Linux
Node.js 22.23.2 as root with dependencies installed from the committed lockfile:
`npm run lint` passed; focused suites passed 29/29; `npm test` passed 368/368
with zero failures and zero skips. The container had no production data or
credentials mounted; external network access was removed before running tests.

Run `npm run lint` and `npm test`. Focused suites:
`host-output-permissions`, `voice-upload`, `transcription-recovery`,
`transcription-receipt-api`, and `nginx-upload-buffer`.

The root-only Linux permission test creates a root-owned 0600 output, verifies
the web UID initially cannot read it, and verifies readability at terminal-event
publication before child exit. It is skipped on non-root/non-Linux hosts.
The Nginx directory probe test likewise requires Linux root and `runuser`.

These tests cover async acknowledgement, a lost response, reusing saved text
without reupload, duplicate uploads, content mismatch, failure receipts,
authentication and cross-account isolation. They do not prove mobile browser
compatibility or provider response latency.

## Operational acceptance boundary

The screenshot upload repair has passed an operator's real desktop paste and
attachment-preview check. The deployed async voice recovery still needs the
operator's mobile acceptance: refresh, retry the retained recording, record a
new voice, and repeat after a page reload on mobile data. Do not clear storage
or delete a failed recording for testing. No claim of mobile acceptance is made.

Applying this PR is not authorization to replace a customized live release
with the entire public main branch. Review release differences, preserve
existing data volumes and configuration, and carry the patch through the
deployment's normal health checks and rollback process.
