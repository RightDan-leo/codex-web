# Remote Worker MVP

This extension lets Codex Web route trusted work to an explicitly registered project on another computer while keeping the public tenant worker as the default executor.

## Security invariants

1. The server sends a logical `projectId`, never an arbitrary host path.
2. The remote worker maps that id to a locally configured `cwd` and optional `CODEX_HOME`.
3. Remote execution is opt-in through an explicit executor target; tenant execution remains the default.
4. A worker can only answer jobs routed to that worker.
5. Duplicate project ids across connected workers are rejected.
6. Disconnecting a worker rejects its in-flight runs instead of silently retrying side-effecting work.
7. The shared worker token is read from the process environment, is not stored in the worker JSON config, and is removed from the Codex app-server environment.
8. Shell commands started by the remote Codex process receive only an allowlisted environment, not arbitrary worker-process secrets.
9. Non-local worker connections require HTTPS.
10. A persisted remote conversation fails closed when its worker is offline; it never silently falls back to the tenant workspace.
11. The server transfers attachments as bounded content records (`name`, MIME type, size, SHA-256, base64), never as a server filesystem path.
12. The server rejects path escapes, symbolic-link sources, size races, non-upload records, more than 12 files, files over 8 MiB, or a combined payload over 16 MiB.
13. The worker verifies size and SHA-256 before writing attachments into a worker-owned disposable directory outside the real project.
14. Only that disposable directory is added as an extra Codex sandbox root; supported image files are passed as local-image inputs.
15. Staged attachments are removed after success, failure, or cancellation. Crash leftovers older than 24 hours are removed when the worker starts again.
16. Graceful server shutdown stops new dispatch first and keeps the worker channel alive until active local and remote jobs have drained.

## Implemented in this slice

- Versioned worker/server protocol types and runtime validation.
- Online worker/project registry and transport-independent gateway.
- Run, progress, thread-started, steering, cancellation, result, and error routing.
- Worker runtime that maps registered project ids to real local workspaces.
- Dependency-free outbound long-poll transport; the worker opens no inbound port.
- Bearer-token protected `/codex-worker` management channel, disabled when `REMOTE_WORKER_TOKEN` is empty.
- Remote worker CLI and strict local JSON configuration loader.
- Persistent per-conversation executor target stored in SQLite.
- Routing of run, thread resume, progress, steering, cancellation, shutdown draining, and completion through the selected executor.
- Owner-authenticated worker status and executor-selection API with CSRF and origin checks.
- Header-integrated web selector for choosing the isolated tenant or an online remote project on a blank task.
- Explicit enabled/disabled transport state and offline status for a previously selected remote project.
- Draft text, quotes, and uploaded draft files remain executor-neutral until the first message, thread, job, or queued/editing prompt locks the conversation.
- Bounded browser-attachment transfer, digest verification, disposable worker staging, image forwarding, normal cleanup, and stale-runtime cleanup.
- Compatibility negotiation: an older connected worker without attachment support fails explicitly instead of silently dropping files.
- Unit and integration coverage for routing, path isolation, polling lifecycle, HTTP authentication, config validation, cancellation, steering, fail-closed behavior, executor selection, UI option mapping, secret isolation, attachment limits, path escape, symlinks, digest tampering, sandbox roots, and cleanup.

The transport is intentionally behind an interface. A future WSS transport can replace long polling without changing the executor, gateway, or local runtime layers.

## Server setup

Generate a unique random token with at least 32 characters and set it only in the server `.env`:

```bash
REMOTE_WORKER_TOKEN=replace-with-a-long-random-secret
REMOTE_WORKER_PATH=/codex-worker
```

If `REMOTE_WORKER_TOKEN` is empty, the worker transport is not mounted. Existing conversations that target a remote project remain remote and report that the project is offline instead of falling back to the server tenant.

For a public deployment, configure the HTTPS reverse proxy to forward `/codex-worker/` to the same Codex Web process. The polling request can remain open for roughly 25 seconds, so response buffering should be disabled and the proxy read timeout should be comfortably longer than that. Attachment payloads can expand through base64 encoding, so the proxy must also permit responses large enough for the documented 16 MiB raw attachment total.

## Worker setup

Build the same repository on the trusted Mac, Windows, or Linux computer that owns the real project:

```bash
npm ci
npm run build
cp remote-worker.example.json remote-worker.json
```

Edit `remote-worker.json`. `serverUrl` is the final HTTPS worker endpoint, for example `https://example.com/codex-worker`. Each project maps a stable logical id to a real local directory:

```json
{
  "id": "magic-zombie",
  "name": "MagicZombie",
  "cwd": "D:\\MagicZombie",
  "codexHome": "C:\\Users\\your-name\\.codex"
}
```

Use a model name supported by that worker's Codex installation for `defaultModel`. Then export the same token in the worker process environment and start it:

```bash
REMOTE_WORKER_TOKEN='the-same-long-random-secret' npm run remote-worker -- ./remote-worker.json
```

On Windows PowerShell:

```powershell
$env:REMOTE_WORKER_TOKEN='the-same-long-random-secret'
npm run remote-worker -- .\remote-worker.json
```

The worker actively registers and polls the server. It never accepts a server-supplied filesystem path and it does not expose a shell, remote desktop port, or generic tunnel.

## Selecting a remote project

1. Start the server and at least one trusted worker.
2. In Codex Web, click **New task** so the blank conversation is selected.
3. Open **Execution location** in the conversation header.
4. Keep **Isolated workspace** for the existing Docker tenant, or select an online remote project.
5. Draft text and attach files as needed, then send the first prompt. The selection is locked when conversation work begins.

Draft text, quotes, and draft attachments do not lock the selector. A Codex thread, sent message, queued prompt, editing prompt, or active job does. This avoids continuing one thread against two unrelated filesystems while still allowing project selection after preparing the first instruction and its files.

A remote project can go offline after selection. The UI marks it offline, and new work for that conversation fails clearly until the same logical project id reconnects.

## Attachment lifecycle

- Maximum 12 attachments per remote turn.
- Maximum 8 MiB per file and 16 MiB raw bytes in total.
- The server reads only registered user uploads from inside that conversation workspace and refuses symbolic links.
- The wire message contains no server absolute or relative path.
- The worker validates the declared size and SHA-256 before writing each file.
- Files are written under the operating system temporary directory, not into the registered project.
- The exact disposable paths are added to the turn prompt; PNG, JPEG, and WebP attachments are also supplied as Codex local-image inputs.
- The Codex sandbox receives the project and disposable runtime as its only runtime workspace roots.
- The disposable directory is removed when the turn settles. Files that should survive must be copied by the task into the registered project.

## Current MVP limits

- Attachments are supported on normal queued turns, but adding new attachments through a live steering instruction is still rejected.
- Files generated inside a remote project remain on that computer. They are not yet copied into Codex Web's durable deliverable store.
- Sending directly from the initial welcome screen still creates and submits a tenant conversation immediately. Create a blank task first when remote execution is required.
- The management transport currently uses authenticated outbound long polling rather than WSS.
- Worker provisioning and token rotation are manual.

## Validation status

The remote runner, owner executor API, secret-isolation adapter, selector helpers, attachment packaging/staging, protocol negotiation, sandbox roots, symlink rejection, digest verification, normal cleanup, and stale-runtime cleanup have dedicated tests or strict TypeScript harnesses in this branch.

The fork still reports no GitHub Actions workflow run or commit status for this PR. Before merging, run the repository's full `npm test` and Docker build on a machine with normal package and container access, then perform one end-to-end Windows or macOS worker run against a disposable project with both a text file and an image attachment.

This branch intentionally remains a Draft PR until those full-project and end-to-end checks pass. The next integration slice should add result-file synchronization with explicit path/size limits, worker enrollment and token rotation, optional WSS transport, and deployment tests on both Windows and macOS.
