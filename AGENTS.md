# Repository guidelines

- Keep the public tenant worker as the default execution path.
- Remote execution must use an explicit logical project id; never accept a server-supplied host path.
- Do not expose worker control tokens to Codex app-server or spawned shell commands.
- Persist a conversation's executor target and fail closed when a selected remote project is offline.
- Run `npm test` before merging changes.
