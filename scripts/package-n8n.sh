#!/usr/bin/env bash
# Build/pack only. Never install into or restart a user's n8n service.
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$ROOT/dist/n8n}"
command -v bun >/dev/null || { echo 'Bun is required to build; installed n8n uses Node.js only.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'npm is required to package.' >&2; exit 1; }
mkdir -p "$OUTPUT"
OUTPUT="$(cd -- "$OUTPUT" && pwd)"
VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/packages/n8n-nodes-ultrabrain/package.json")"
TARGET="$OUTPUT/n8n-nodes-ultrabrain-$VERSION.tgz"
[[ ! -e "$TARGET" ]] || { echo 'Package already exists; choose a new output directory to avoid overwriting it.' >&2; exit 1; }
bun "$ROOT/scripts/build-n8n.mjs"
npm pack "$ROOT/packages/n8n-nodes-ultrabrain" --ignore-scripts --pack-destination "$OUTPUT"
python3 - "$TARGET" <<'PY'
import sys,tarfile,hashlib
from pathlib import Path
p=Path(sys.argv[1])
with tarfile.open(p) as t:
    names=t.getnames()
    allowed=lambda n: n.startswith('package/dist/') or n in ('package/package.json','package/README.md','package/LICENSE')
    if not all(allowed(n) and '..' not in Path(n).parts for n in names):raise SystemExit('Unexpected packed file')
    required={'package/dist/runtime.cjs','package/dist/nodes/Ultrabrain/Ultrabrain.node.js','package/dist/credentials/UltrabrainApi.credentials.js'}
    if not required.issubset(names):raise SystemExit('Incomplete n8n package')
    if any(m.issym() or m.islnk() for m in t.getmembers()):raise SystemExit('Unexpected package link')
digest=hashlib.sha256(p.read_bytes()).hexdigest()
p.with_suffix(p.suffix+'.sha256').write_text(digest+'  '+p.name+'\n')
print(p)
print('SHA-256:',digest)
PY
