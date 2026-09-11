#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export ULTRABRAIN_HOME="${ULTRABRAIN_HOME:-$HOME/.local/share/ultrabrain}"
if [[ "$EUID" -eq 0 ]]; then echo 'Build and run as a non-root service user.' >&2; exit 1; fi
cd "$ROOT"
python3 scripts/upstreams.py verify --runtime-only
mapfile -t paths < <(python3 - <<'PY'
import json,os
from pathlib import Path
p=json.load(open('upstreams.lock.json'))['projects']; h=Path(os.environ['ULTRABRAIN_HOME']).resolve()
print(h/'runtime'/f"postgres-{p['postgres']['version']}-{p['postgres']['revision'][:12]}-pgvector-{p['pgvector']['revision'][:12]}")
print(h/'build'/f"postgres-{p['postgres']['revision'][:12]}-{p['pgvector']['revision'][:12]}")
print(p['postgres']['revision']+':'+p['pgvector']['revision'])
PY
)
PREFIX="${paths[0]}"; BUILD="${paths[1]}"; MARKER="${paths[2]}"
if [[ -f "$PREFIX/.ultrabrain-build" ]] && [[ "$(cat "$PREFIX/.ultrabrain-build")" == "$MARKER" ]]; then
  echo 'Pinned PostgreSQL and pgvector already built.'; exit 0
fi
# Never reinstall shared libraries into a running release, even after a damaged marker.
python3 - "$ULTRABRAIN_HOME/postgres/runtime.json" "$(basename "$PREFIX")" <<'PYBOUND'
import json,sys
from pathlib import Path
p=Path(sys.argv[1])
if p.exists() and json.loads(p.read_text()).get('directory') == sys.argv[2]:
    raise SystemExit('Refusing to overwrite the active runtime. Build a new pinned release in a different directory.')
PYBOUND
JOBS="${ULTRABRAIN_BUILD_JOBS:-2}"
[[ "$JOBS" =~ ^[1-9][0-9]?$ ]] || { echo 'ULTRABRAIN_BUILD_JOBS must be 1..99' >&2; exit 1; }
mkdir -p "$BUILD/postgres" "$PREFIX"
cd "$BUILD/postgres"
"$ROOT/vendor/postgres/configure" --prefix="$PREFIX" --without-icu --with-ssl=openssl --without-readline
make -j "$JOBS" world-bin
make install-world-bin
# Build extensions in a private copy, not by modifying the tracked upstream source.
python3 - "$ROOT/vendor/pgvector" "$BUILD/pgvector" <<'PY'
import shutil,sys
shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True,ignore=shutil.ignore_patterns('.git'))
PY
cd "$BUILD/pgvector"
make clean PG_CONFIG="$PREFIX/bin/pg_config"
make -j "$JOBS" PG_CONFIG="$PREFIX/bin/pg_config"
make install PG_CONFIG="$PREFIX/bin/pg_config"
printf '%s\n' "$MARKER" > "$PREFIX/.ultrabrain-build"
echo 'Pinned native PostgreSQL and pgvector build completed.'
