# Remote Worker MVP

This extension adds the transport-independent core needed to run Codex against an explicitly registered project on another trusted computer while keeping the public tenant worker as the default executor.

## Security invariants

1. The server sends a logical `projectId`, never an arbitrary host path.
2. The remote worker maps that id to a locally configured `cwd` and optional `CODEX_HOME`.
3. Remote execution is opt-in through an explicit executor target; tenant execution remains the default.
4. A worker can only answer jobs routed to that worker.
5. Duplicate project ids across connected workers are rejected.
6. Disconnecting a worker rejects its in-flight runs instead of silently retrying side-effecting work.

## Included in this first slice

- Versioned worker/server protocol types and runtime validation.
- Online worker/project registry and transport-independent gateway.
- Run, progress, thread-started, steering, cancellation, result, and error routing.
- Worker runtime that maps registered project ids to real local workspaces.
- Executor routing seam between existing tenant execution and remote execution.

## Next slice

- Authenticated WSS transport (worker initiates outbound connection).
- Remote worker CLI and local configuration file.
- Adapter from `RemoteWorkerRuntime` to the existing `startAppServerTurn` API.
- Persistent executor/project records in SQLite.
- Admin-only project selector and worker online/offline status in the web UI.
- Attachment transfer with size limits and explicit per-job staging.
