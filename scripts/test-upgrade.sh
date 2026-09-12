#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${ULTRABRAIN_TEST_ALLOW_WRITE:-}" == 1 ]] || { echo 'Isolated test installation required' >&2; exit 1; }
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${ULTRABRAIN_UPGRADE_BASE:-38e0e6657561e17ba85c71d0783d604242a054e8}"
[[ "$BASE" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid base commit" >&2; exit 1; }
WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/ub-upgrade.XXXXXX")"
# Run the actual immutable old application before the candidate.
git -c core.hooksPath=/dev/null clone --no-checkout https://github.com/youq616/ultrabrain.git "$WORK/old"
git -C "$WORK/old" -c core.hooksPath=/dev/null checkout --detach "$BASE"
[[ "$(git -C "$WORK/old" rev-parse HEAD)" == "$BASE" ]]
bash "$WORK/old/scripts/bootstrap-linux.sh"
bun "$ROOT/test/upgrade-fixture.mjs" seed "$WORK/old" "$WORK/evidence"
cd "$ROOT"
git submodule update --init --depth 1 vendor/gbrain vendor/postgres vendor/pgvector
python3 scripts/upstreams.py verify --runtime-only
(cd vendor/gbrain && bun install --frozen-lockfile --ignore-scripts)
bash scripts/build-postgres.sh
python3 scripts/postgres.py stop
python3 scripts/postgres.py activate-runtime
python3 scripts/postgres.py init
bun src/cli.mjs migrate
bun test/upgrade-fixture.mjs verify "$ROOT" "$WORK/evidence"
bun src/cli.mjs migrate
bun src/cli.mjs health
cp "$WORK/evidence/upgrade-gate.json" "${RUNNER_TEMP:-/tmp}/ultrabrain-upgrade-gate.json"
# Publish only the synthetic report, never the database, outbox or secrets.
