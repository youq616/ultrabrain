#!/usr/bin/env python3
"""Reviewable upstream updates. Never merge, deploy, migrate or push automatically."""
import argparse
import json
import re
import subprocess
import tempfile
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

def check(name=None):
    report = {'policy': 'review-only; no local files or running services changed', 'projects': {}}
    for project, p in projects().items():
        if name and name != project: continue
        item = {'locked': p['revision'], 'role': p['role'], 'origins': {}}
        for repo in dict.fromkeys([p['upstream'], p.get('fork', p['upstream'])]):
            try:
                reference = p.get('tracking_ref', p['ref'])
                current = refs(repo, reference).get(reference)
                if current is None: raise RuntimeError('Tracked reference was not found')
                item['origins'][repo] = {'ref': reference, 'revision': current,
                    'changed': current != p['revision'],
                    'compare': f"https://github.com/{repo}/compare/{p['revision']}...{current}" if current else None}
                if project in ('postgres', 'pgvector'):
                    candidates = []
                    for tag, revision in refs(repo, 'refs/tags/*').items():
                        pattern = r'refs/tags/REL_(\d+)_(\d+)$' if project == 'postgres' else r'refs/tags/v(\d+)\.(\d+)\.(\d+)$'
                        m = re.fullmatch(pattern, tag)
                        if m:
                            candidates.append((tuple(map(int, m.groups())), tag, revision))
                    if candidates:
                        version, tag, revision = max(candidates)
                        item['latest_stable'] = {'version': '.'.join(map(str, version)), 'ref': tag, 'revision': revision}
                        if project == 'postgres':
                            major = int(p['version'].split('.')[0])
                            same = [c for c in candidates if c[0][0] == major]
                            if same:
                                v, t, r = max(same)
                                item['latest_same_major'] = {'version': '.'.join(map(str, v)), 'ref': t, 'revision': r}
                            item['major_migration_required'] = version[0] != major
            except (subprocess.SubprocessError, OSError, RuntimeError) as e:
                item['origins'][repo] = {'error': type(e).__name__, 'checked': False}
        report['projects'][project] = item
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if any('error' in origin for item in report['projects'].values() for origin in item['origins'].values()):
        raise SystemExit(2)

def prove_install_source(repository_url, revision):
    if not re.fullmatch(r'https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?', repository_url):
        raise RuntimeError('Only explicit public GitHub HTTPS installation sources are supported')
    with tempfile.TemporaryDirectory(prefix='ultrabrain-source-probe-') as folder:
        path = Path(folder)
        run('git', 'init', '--bare', str(path))
        # Independent, empty repository: no maintainer object cache can hide an
        # unreachable gitlink. No checkout, build, hooks or upstream script execution.
        run('git', '-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--depth=1', repository_url, revision, cwd=path)
        if run('git', 'rev-parse', 'FETCH_HEAD^{commit}', cwd=path) != revision:
            raise RuntimeError('Installer source resolved a different revision')
    return True

def prepare(name, ref, accept_license_change=False, use_upstream_source=False):
    if run('git', 'status', '--porcelain'):
        raise RuntimeError('A clean working tree is required; no changes were made')
    lock = json.loads(LOCK.read_text())
    p = lock['projects'][name]
    if not re.fullmatch(r'refs/(heads|tags)/[A-Za-z0-9_.\-/]+', ref) or '..' in ref:
        raise RuntimeError('Pass a full refs/heads/... or refs/tags/... reference')
    if name == 'postgres' and not re.fullmatch(r'refs/tags/REL_\d+_\d+', ref):
        raise RuntimeError('PostgreSQL candidates must be stable release tags, not development heads')
    if name == 'pgvector' and not re.fullmatch(r'refs/tags/v\d+\.\d+\.\d+', ref):
        raise RuntimeError('pgvector candidates must use a stable version tag')
    upstream = p['upstream']
    path = ROOT / p['path']
    verify({name})
    run('git', 'fetch', '--no-tags', f'https://github.com/{upstream}.git', ref, cwd=path)
    revision = run('git', 'rev-parse', 'FETCH_HEAD^{commit}', cwd=path)
    if revision == p['revision']:
        print('Already pinned to this revision.'); return
    changed = run('git', 'diff', '--name-only', p['revision'], revision, cwd=path).splitlines()
    licenses = [f for f in changed if re.search(r'(^|/)(LICENSE|COPYING|NOTICE|COPYRIGHT)', f, re.I)]
    if licenses and not accept_license_change:
        raise RuntimeError('License files changed. Review them and explicitly pass --accept-license-change: ' + ', '.join(licenses))
    configured = run('git','config','--file','.gitmodules','--get',f"submodule.{p['path']}.url")
    install_url = f'https://github.com/{upstream}.git' if use_upstream_source else configured
    try: prove_install_source(install_url, revision)
    except (RuntimeError, subprocess.SubprocessError) as error:
        raise RuntimeError('Candidate cannot be fetched by a clean installer from its configured source. Synchronize the fork or review --use-upstream-source.') from error
    branch = f'upstream/{name}-{revision[:12]}'
    run('git', 'switch', '-c', branch)
    run('git', 'checkout', '--detach', revision, cwd=path)
    old = p['revision']; p.setdefault('tracking_ref', p['ref']); p['revision'] = revision; p['ref'] = ref
    if use_upstream_source:
        run('git','config','--file','.gitmodules',f"submodule.{p['path']}.url",install_url)
    if name == 'postgres': p['version'] = ref.rsplit('/', 1)[1].removeprefix('REL_').replace('_', '.')
    if name == 'pgvector': p['version'] = ref.rsplit('/', 1)[1].removeprefix('v')
    LOCK.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + '\n')
    plan = {'branch': branch, 'project': name, 'base': old, 'candidate': revision,
        'changed_files': changed, 'license_files_changed': licenses,
        'installation_source': install_url, 'fresh_fetch_verified': True,
        'gitlink_path': p['path'], 'role': p['role'],
        'risk_flags': classify_changes(name,changed),
        'feature_mapping': 'compat/upstream-features.json',
        'affected_features': affected_features(name,changed),
        'compare': f'https://github.com/{upstream}/compare/{old}...{revision}',
        'required': ['Review functionality and licenses', 'Run unit and native integration tests',
                     'Verify backup/restore on staging', 'Approve a release; do not update live services directly']}
    (ROOT / 'upgrade-candidate.json').write_text(json.dumps(plan, indent=2) + '\n')
    print(json.dumps(plan, indent=2))
    print('Candidate only. Review, git add the lock and gitlink, commit and open a PR. Nothing was deployed.')

def affected_features(project, files):
    mapping = json.loads((ROOT/'compat/upstream-features.json').read_text())
    return [f['id'] for f in mapping['features'] if f['upstream']==project and
            any(path.startswith(prefix) for path in files for prefix in f['watch_prefixes'])]

def classify_changes(project, files):
    flags = {'source-review-required'}
    if project == 'openviking': flags.add('reference-only-no-runtime-feature-added')
    if project in ('postgres','pgvector'): flags.add('database-migration-review-required')
    for path in files:
        low = path.lower()
        if any(word in low for word in ('auth','permission','scope','fence','security')): flags.add('authorization-review')
        if any(word in low for word in ('schema','migration','migrate')): flags.add('data-migration-review')
        if any(word in low for word in ('license','copying','copyright','notice')): flags.add('license-review')
    return sorted(flags)  # heuristic routing, never an assertion of safety

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    c = sub.add_parser('check'); c.add_argument('--project', choices=projects())
    v = sub.add_parser('verify')
    v.add_argument('--runtime-only', action='store_true')
    p = sub.add_parser('prepare')
    p.add_argument('project', choices=projects()); p.add_argument('--ref', required=True)
    p.add_argument('--accept-license-change', action='store_true')
    p.add_argument('--use-upstream-source', action='store_true', help='Explicitly change the installation URL to the original upstream after a clean-fetch proof')
    a = parser.parse_args()
    if a.command == 'check': check(a.project)
    elif a.command == 'verify':
        verify({'gbrain','postgres','pgvector'} if a.runtime_only else None); print('Pinned source check passed.')
    else: prepare(a.project, a.ref, a.accept_license_change, a.use_upstream_source)
if __name__ == '__main__':
    try: main()
    except (RuntimeError, subprocess.SubprocessError, OSError, KeyError) as e:
        raise SystemExit(f'upstream operation failed: {e}')
