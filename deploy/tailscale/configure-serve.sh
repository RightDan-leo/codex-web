#!/usr/bin/env bash
set -Eeuo pipefail

backend="${CODEX_WEB_BACKEND:-http://127.0.0.1:${CODEX_WEB_PORT:-37821}}"

case "$backend" in
  http://127.0.0.1:*) ;;
  *)
    echo "Refusing a non-loopback backend: $backend" >&2
    echo "Keep Codex Web private and let Tailscale Serve terminate HTTPS." >&2
    exit 2
    ;;
esac

command -v tailscale >/dev/null 2>&1 || {
  echo "tailscale is not installed on this host." >&2
  exit 3
}

tailscale status >/dev/null
tailscale serve --bg "$backend"

echo "Tailscale Serve now proxies HTTPS traffic to $backend"
echo "Use the HTTPS hostname printed by 'tailscale serve status'."
tailscale serve status
