#!/usr/bin/env bash
# Build/package only; never modifies installed clients or starts a service.
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$ROOT/dist/client}"
command -v bun >/dev/null; command -v npm >/dev/null; command -v python3 >/dev/null
mkdir -p "$OUTPUT"; OUTPUT="$(cd -- "$OUTPUT" && pwd)"
VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/packages/ultrabrain-client/package.json")"
TARGET="$OUTPUT/ultrabrain-client-$VERSION.tgz"
[[ ! -e "$TARGET" ]] || { echo 'Choose a new output directory; package already exists.' >&2; exit 1; }
bun "$ROOT/scripts/build-client.mjs"
cp "$ROOT/scripts/client-config.py" "$ROOT/scripts/client-profile.py" "$ROOT/packages/ultrabrain-client/dist/"
npm pack "$ROOT/packages/ultrabrain-client" --ignore-scripts --pack-destination "$OUTPUT"
python3 - "$TARGET" <<'PY'
import hashlib,tarfile,sys
from pathlib import Path
p=Path(sys.argv[1])
with tarfile.open(p) as t:
 for m in t.getmembers():
  if not m.isfile() or '..' in Path(m.name).parts or not (m.name.startswith('package/dist/') or m.name in ['package/package.json','package/README.md','package/LICENSE']):raise SystemExit('Unexpected package entry')
 if 'package/dist/cli.cjs' not in t.getnames():raise SystemExit('Missing client CLI')
p.with_suffix(p.suffix+'.sha256').write_text(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n')
print('Client package verified:',p.name)
PY
