# Remote Worker MVP

This extension lets Codex Web route trusted work to an explicitly registered project on another computer while keeping the public tenant worker as the default executor.

## Security invariants

1. The server sends a logical `projectId`, never an arbitrary host path.
2. The remote worker maps that id to a locally configured `cwd` and optional `CODEX_HOME`.
3. Remote execution is opt-in through an explicit executor target; tenant execution remains the default.
4. A worker can only answer jobs routed to that worker.
5. Duplicate project ids across connected workers are rejected.
6. Disconnecting a worker rejects its in-flight runs instead of silently retrying side-effecting work.
7. The shared worker token is read from the process environment and is not stored in the worker JSON config.
8. Non-local worker connections require HTTPS.

## Implemented in this slice

- Versioned worker/server protocol types and runtime validation.
- Online worker/project registry and transport-independent gateway.
- Run, progress, thread-started, steering, cancellation, result, and error routing.
- Worker runtime that maps registered project ids to real local workspaces.
- Executor routing seam between existing tenant execution and remote execution.
- Adapter from `RemoteWorkerRuntime` to the existing `startAppServerTurn` implementation.
- Dependency-free outbound long-poll transport; the worker opens no inbound port.
- Bearer-token protected `/codex-worker` management channel, disabled when `REMOTE_WORKER_TOKEN` is empty.
- Remote worker CLI and strict local JSON configuration loader.
- Unit/integration coverage for routing, path isolation, polling lifecycle, HTTP authentication, config validation, cancellation, and steering-error isolation.

The transport is intentionally behind an interface. A future WSS transport can replace long polling without changing the executor, gateway, or local runtime layers.

## Server setup

Generate a unique random token with at least 32 characters and set it only in the server `.env`:

```bash
REMOTE_WORKER_TOKEN=replace-with-a-long-random-secret
REMOTE_WORKER_PATH=/codex-worker
```

If `REMOTE_WORKER_TOKEN` is empty, the remote worker channel is not mounted.

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

## Not wired into the web product yet

The transport and local execution path are implemented, but normal Codex Web conversations still use the tenant executor. The next integration slice is deliberately separate so the existing queue remains safe while the data model changes.

Remaining product integration:

- Persist each conversation's executor target (`tenant` or a remote `projectId`) in SQLite.
- Route `CodexRunner.run`, steering, cancellation, and thread state through the selected executor.
- Expose authenticated worker/project status to the owner UI.
- Add an explicit project selector and clear offline state in the web UI.
- Stage attachments for remote jobs with explicit limits and cleanup rules.
- Decide whether remote-generated deliverables are copied back to server storage or remain project files.
