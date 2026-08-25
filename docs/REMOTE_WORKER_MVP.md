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
- Web selector for choosing the isolated tenant or an online remote project on a blank new task.
- Offline status in the web selector for a previously selected remote project.
- Unit and integration coverage for routing, path isolation, polling lifecycle, HTTP authentication, config validation, cancellation, steering, fail-closed behavior, executor selection, and secret isolation.

The transport is intentionally behind an interface. A future WSS transport can replace long polling without changing the executor, gateway, or local runtime layers.

## Server setup

Generate a unique random token with at least 32 characters and set it only in the server `.env`:

```bash
REMOTE_WORKER_TOKEN=replace-with-a-long-random-secret
REMOTE_WORKER_PATH=/codex-worker
```

If `REMOTE_WORKER_TOKEN` is empty, the worker transport is not mounted. Existing conversations that target a remote project remain remote and report that the project is offline instead of falling back to the server tenant.

For a public deployment, configure the HTTPS reverse proxy to forward `/codex-worker/` to the same Codex Web process. The polling request can remain open for roughly 25 seconds, so response buffering should be disabled and the proxy read timeout should be comfortably longer than that.

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
3. Use the execution-position control above the composer.
4. Keep **Isolated workspace** for the existing Docker tenant, or select an online remote project.
5. Send the first prompt. The selection is then locked for that conversation.

The selector is deliberately immutable after the conversation has a message, Codex thread, draft attachment, queued prompt, or active job. This avoids continuing one thread against two unrelated filesystems.

A remote project can go offline after selection. The UI marks it offline, and new work for that conversation fails clearly until the same logical project id reconnects.

## Current MVP limits

- Conversation attachments are not staged to a remote worker. Put required files inside the registered project directory before sending the task.
- Files generated inside a remote project remain on that computer. They are not yet copied into Codex Web's durable deliverable store.
- Sending directly from the initial welcome screen still creates and submits a tenant conversation immediately. Create a blank task first when remote execution is required.
- The management transport currently uses authenticated outbound long polling rather than WSS.
- Worker provisioning and token rotation are manual.

The next integration slice should add explicit attachment staging, result synchronization with size and path limits, worker enrollment/rotation, and end-to-end deployment tests on both Windows and macOS.
