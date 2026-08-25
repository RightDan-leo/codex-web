# Deployment

## Local Docker deployment

Follow the root README. Docker named volumes persist the SQLite database, tenant workspaces, Codex login/thread state, and the seeded Codex CLI runtime.

Useful checks:

```bash
docker compose ps
docker compose logs --tail=200 app
curl --fail http://127.0.0.1:37821/codex-web/api/health
```

Back up all three named volumes before upgrades. Keep `app.env` outside source control. Reserve `.env` for non-secret Docker Compose interpolation settings only. On Linux, protect application secrets with `chown root:10001 app.env` and `chmod 0640 app.env`; the fixed container web process uses group 10001.

Docker grants the application up to 30 minutes after `SIGTERM` to drain active Codex work. New dispatch stops immediately, queued jobs stay persisted, and the container exits once active executions finish. Avoid overriding `stop_grace_period` with a shorter value unless you accept interrupted jobs.

## Reverse proxy

Terminate TLS at your reverse proxy and forward `/codex-web/` to `http://127.0.0.1:37821/codex-web/`. Preserve the path prefix, pass the original host and protocol headers, disable response buffering for event streams, and use a long read timeout for active tasks.

Set `PUBLIC_BASE_URL` to the final HTTPS URL. Do not publish container port 37821 directly to the internet.

`PUBLIC_BASE_URL` is also the browser write-origin authority. It must be an absolute HTTP(S) URL whose path matches `BASE_PATH`; non-local URLs must use HTTPS. Forwarded host/protocol headers are not used to authorize browser writes. This makes the same application image safe to move from a private Tailscale hostname to a public domain by changing configuration and the proxy layer, without migrating application data.

## Private mobile access with Tailscale Serve

Tailscale is the recommended first deployment for a single owner. Install Tailscale on the Linux server and the phone, sign both into the same tailnet, and keep Docker's published application port on `127.0.0.1`. Do not open TCP 37821 in the cloud security group.

On Ubuntu, follow the [official Linux installation guide](https://tailscale.com/docs/install/linux), then complete the interactive device login:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

After `docker compose up -d --build` is healthy, configure host-level Tailscale Serve:

```bash
bash deploy/tailscale/configure-serve.sh
tailscale serve status
```

The command prints an HTTPS hostname similar to `https://machine-name.example.ts.net`. Set the application URL, including the existing base path, in `app.env`:

```dotenv
PUBLIC_BASE_URL=https://machine-name.example.ts.net/codex-web
```

Then recreate the application container and open that exact URL on the phone. The worker endpoint uses the same hostname with `/codex-worker`:

```text
https://machine-name.example.ts.net/codex-worker
```

Tailscale Serve is only reachable by authenticated devices in the tailnet. It is not a public anonymous URL. Remote Worker still uses its own bearer token in addition to the Tailscale network boundary.

To inspect the active proxy configuration, use `tailscale serve status`. Do not run `tailscale serve reset` on a host that serves other applications unless you intend to remove their routes too.

## Later migration to a public domain

The application does not depend on Tailscale-specific request headers or hostnames. For a public deployment:

1. Point a domain at the server and terminate TLS with a maintained reverse proxy.
2. Start from `deploy/nginx/codex-web.conf.example` and replace its example domain and certificate paths.
3. Change `PUBLIC_BASE_URL` to `https://your-domain.example/codex-web`.
4. Keep port 37821 bound to loopback; expose only HTTPS port 443.
5. Recreate the container and update each Remote Worker `serverUrl` to the new `/codex-worker` URL.

Changing the public URL does not change the SQLite database, named volumes, executor project ids, or Codex thread ids. Existing browser sessions use Secure cookies scoped to the old hostname, so log in again after the switch.

## Small-server resource profile

The Compose defaults limit the application to 3 GiB and 1.8 CPU, leaving headroom on a 2 vCPU / 4 GiB host for the operating system, Docker, and Tailscale. Override `CODEX_WEB_MEMORY_LIMIT` and `CODEX_WEB_CPU_LIMIT` in `.env` on larger hosts. These are ceilings, not reservations.

For optional voice transcription, keep `DASHSCOPE_API_KEY` only in `app.env`. The default context budget is 500 approximate tokens, two images, and 2 MiB per image. Adjust `TRANSCRIPTION_CONTEXT_TOKEN_BUDGET`, `TRANSCRIPTION_CONTEXT_MAX_IMAGES`, and `TRANSCRIPTION_CONTEXT_MAX_IMAGE_BYTES` only after considering request cost and data exposure.

## Updating

```bash
git pull --ff-only
docker compose up -d --build
```

The container seeds a newer bundled Codex CLI into the persistent runtime volume on startup. Existing login and thread state remain in the tenant volume.

After upgrading, verify that archived conversations remain listed under personal settings and that any job interrupted by an ungraceful previous stop has a visible interruption message instead of being retried.
