#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export ULTRABRAIN_HOME="${ULTRABRAIN_HOME:-$HOME/.local/share/ultrabrain}"
if [[ "$EUID" -eq 0 ]]; then echo 'Run as an unprivileged Linux user, not root.' >&2; exit 1; fi
for cmd in bun git python3 make gcc bison flex pkg-config; do
  command -v "$cmd" >/dev/null || { echo "Missing $cmd; see README prerequisites." >&2; exit 1; }
done
bun -e 'const v=Bun.version.split(".").map(Number); if(v[0]<1 || (v[0]===1 && (v[1]<3 || (v[1]===3 && v[2]<11)))) process.exit(1)'
mkdir -p "$ULTRABRAIN_HOME"
export GBRAIN_HOME="$ULTRABRAIN_HOME/gbrain"
cd "$ROOT"
git submodule update --init --depth 1 vendor/gbrain vendor/postgres vendor/pgvector
python3 scripts/upstreams.py verify --runtime-only
(cd vendor/gbrain && bun install --frozen-lockfile --ignore-scripts)
bash scripts/build-postgres.sh
python3 scripts/postgres.py init
bun src/cli.mjs migrate
printf '\nReady. Start local MCP: bun %q/src/cli.mjs mcp\n' "$ROOT"
printf 'Database remains running. Stop explicitly with: bun %q/src/cli.mjs db stop\n' "$ROOT"
printf 'No paid model, unattended task or public network listener was enabled.\n'
