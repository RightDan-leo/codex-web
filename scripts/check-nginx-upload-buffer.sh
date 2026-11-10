#!/bin/sh
# Read-only configuration check plus a temporary write probe; no recursive chmod.
set -eu
worker_user=${1:-www-data}
buffer=${2:-/var/lib/codex-web-nginx/client-body}
case "$buffer" in /*) ;; *) echo "Buffer path must be absolute" >&2; exit 1;; esac
[ -d "$buffer" ] && [ ! -L "$buffer" ] || { echo "Buffer directory is missing or is a symlink" >&2; exit 1; }
runuser -u "$worker_user" -- sh -c '
set -eu
probe=$(mktemp "$1/.codex-upload-check.XXXXXX")
trap '\''rm -f -- "$probe"'\'' EXIT HUP INT TERM
printf "%s" upload-check > "$probe"
[ "$(cat "$probe")" = upload-check ]
' check-upload-buffer "$buffer"
printf 'Upload buffer is writable by %s\n' "$worker_user"
