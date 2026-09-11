#!/usr/bin/env python3
"""Reviewable upstream updates. Never merge, deploy, migrate or push automatically."""
import argparse
import json
import re
import subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'upstreams.lock.json'

def run(*args, cwd=ROOT):
    return subprocess.check_output(list(args), cwd=cwd, text=True, stderr=subprocess.PIPE, timeout=180).strip()

def projects():
    return json.loads(LOCK.read_text())['projects']

def verify(names=None):
    for name, p in projects().items():
        if names and name not in names:
            continue
        if not re.fullmatch(r'[a-f0-9]{40}', p['revision']):
            raise RuntimeError(f'{name}: revision is not an immutable SHA')
        path = ROOT / p['path']
        actual = run('git', 'rev-parse', 'HEAD', cwd=path)
        if actual != p['revision']:
            raise RuntimeError(f'{name}: checkout differs from lock')
        if run('git', 'status', '--porcelain', '--untracked-files=no', cwd=path):
            raise RuntimeError(f'{name}: tracked source modifications refused')
        entry = run('git', 'ls-files', '--stage', '--', p['path'])
        if not entry.startswith(f"160000 {p['revision']} "):
            raise RuntimeError(f'{name}: gitlink differs from lock')
    return True

def refs(repo, pattern):
    out = run('git', 'ls-remote', f'https://github.com/{repo}.git', pattern, pattern + '^{}')
    result = {}
    peeled = {}
    for line in out.splitlines():
        if not line.strip(): continue
        sha, ref = line.split()
        if ref.endswith('^{}'): peeled[ref[:-3]] = sha
        else: result[ref] = sha
    result.update(peeled)  # Annotated tags pin the commit, never the tag object.
    return result

def check():
    report = {'policy': 'review-only; no local files or running services changed', 'projects': {}}
    for name, p in projects().items():
        item = {'locked': p['revision'], 'role': p['role'], 'origins': {}}
        for repo in dict.fromkeys([p['upstream'], p.get('fork', p['upstream'])]):
            try:
                reference = p['ref']
                current = refs(repo, reference).get(reference)
                if current is None: raise RuntimeError('Tracked reference was not found')
                item['origins'][repo] = {'ref': reference, 'revision': current,
                    'changed': current != p['revision'],
                    'compare': f"https://github.com/{repo}/compare/{p['revision']}...{current}" if current else None}
                if name in ('postgres', 'pgvector'):
                    candidates = []
                    for tag, revision in refs(repo, 'refs/tags/*').items():
                        pattern = r'refs/tags/REL_(\d+)_(\d+)$' if name == 'postgres' else r'refs/tags/v(\d+)\.(\d+)\.(\d+)$'
                        m = re.fullmatch(pattern, tag)
                        if m:
                            candidates.append((tuple(map(int, m.groups())), tag, revision))
                    if candidates:
                        version, tag, revision = max(candidates)
                        item['latest_stable'] = {'version': '.'.join(map(str, version)), 'ref': tag, 'revision': revision}
                        if name == 'postgres':
                            major = int(p['version'].split('.')[0])
                            same = [c for c in candidates if c[0][0] == major]
                            if same:
                                v, t, r = max(same)
                                item['latest_same_major'] = {'version': '.'.join(map(str, v)), 'ref': t, 'revision': r}
                            item['major_migration_required'] = version[0] != major
            except (subprocess.SubprocessError, OSError, RuntimeError) as e:
                item['origins'][repo] = {'error': type(e).__name__, 'checked': False}
        report['projects'][name] = item
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if any('error' in origin for item in report['projects'].values() for origin in item['origins'].values()):
        raise SystemExit(2)

def prepare(name, ref, accept_license_change=False):
    if run('git', 'status', '--porcelain'):
        raise RuntimeError('A clean working tree is required; no changes were made')
    lock = json.loads(LOCK.read_text())
    p = lock['projects'][name]
    if not re.fullmatch(r'refs/(heads|tags)/[A-Za-z0-9_.\-/]+', ref) or '..' in ref:
        raise RuntimeError('Pass a full refs/heads/... or refs/tags/... reference')
    if name == 'postgres' and not re.fullmatch(r'refs/tags/REL_\d+_\d+', ref):
        raise RuntimeError('PostgreSQL candidates must be stable release tags, not development heads')
    upstream = p['upstream']
    path = ROOT / p['path']
    run('git', 'fetch', '--no-tags', f'https://github.com/{upstream}.git', ref, cwd=path)
    revision = run('git', 'rev-parse', 'FETCH_HEAD^{commit}', cwd=path)
    if revision == p['revision']:
        print('Already pinned to this revision.'); return
    changed = run('git', 'diff', '--name-only', p['revision'], revision, cwd=path).splitlines()
    licenses = [f for f in changed if re.search(r'(^|/)(LICENSE|COPYING|NOTICE|COPYRIGHT)', f, re.I)]
    if licenses and not accept_license_change:
        raise RuntimeError('License files changed. Review them and explicitly pass --accept-license-change: ' + ', '.join(licenses))
    branch = f'upstream/{name}-{revision[:12]}'
    run('git', 'switch', '-c', branch)
    run('git', 'checkout', '--detach', revision, cwd=path)
    old = p['revision']; p['revision'] = revision; p['ref'] = ref
    if name == 'postgres': p['version'] = ref.rsplit('/', 1)[1].removeprefix('REL_').replace('_', '.')
    if name == 'pgvector': p['version'] = ref.rsplit('/', 1)[1].removeprefix('v')
    LOCK.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + '\n')
    plan = {'branch': branch, 'project': name, 'base': old, 'candidate': revision,
        'changed_files': changed, 'license_files_changed': licenses,
        'compare': f'https://github.com/{upstream}/compare/{old}...{revision}',
        'required': ['Review functionality and licenses', 'Run unit and native integration tests',
                     'Verify backup/restore on staging', 'Approve a release; do not update live services directly']}
    (ROOT / 'upgrade-candidate.json').write_text(json.dumps(plan, indent=2) + '\n')
    print(json.dumps(plan, indent=2))
    print('Candidate only. Review, git add the lock and gitlink, commit and open a PR. Nothing was deployed.')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('check')
    v = sub.add_parser('verify')
    v.add_argument('--runtime-only', action='store_true')
    p = sub.add_parser('prepare')
    p.add_argument('project', choices=projects()); p.add_argument('--ref', required=True)
    p.add_argument('--accept-license-change', action='store_true')
    a = parser.parse_args()
    if a.command == 'check': check()
    elif a.command == 'verify':
        verify({'gbrain','postgres','pgvector'} if a.runtime_only else None); print('Pinned source check passed.')
    else: prepare(a.project, a.ref, a.accept_license_change)
if __name__ == '__main__':
    try: main()
    except (RuntimeError, subprocess.SubprocessError, OSError, KeyError) as e:
        raise SystemExit(f'upstream operation failed: {e}')
