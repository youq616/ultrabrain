#!/usr/bin/env python3
"""Private recovery sets: managed database + explicitly consented native files.

Only the operator CLI can run this module; it is not an MCP tool. Stage never
applies credentials or starts services. Database restore requires trust in the
backup's origin in addition to a manifest digest obtained separately.
"""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MAX_FILES = 20000
MAX_BYTES = 8 * 1024**3
MAX_MANIFEST = 8 * 1024**2
FIXED = ('postgres/state.json', 'postgres/runtime.json', 'service.env', 'personal-console-token')
REQUIRED = ('postgres/state.json', 'postgres/runtime.json', 'gbrain/.gbrain/config.json')
EXCLUDED = ['runtime binaries and OS packages', 'live PostgreSQL data/WAL files',
            'environment-only secrets and external credential stores', 'external blob stores',
            'source repositories and client-side journals', 'user systemd units and Agent configurations']
HEX = re.compile(r'[a-f0-9]{64}')

class RecoveryError(Exception):
    pass

def need(ok, code):
    if not ok:
        raise RecoveryError(code)

def encoded(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True, indent=2) + '\n').encode()

def load_json(raw):
    def unique(items):
        value = {}
        for k, v in items:
            need(k not in value, 'duplicate_key')
            value[k] = v
        return value
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(RecoveryError('invalid_json')))
    except (UnicodeError, ValueError):
        raise RecoveryError('invalid_json') from None

def safe_relative(value):
    need(isinstance(value, str) and 0 < len(value) <= 1024 and '\\' not in value
         and not any(ord(c) < 32 or ord(c) == 127 for c in value), 'unsafe_path')
    p = PurePosixPath(value)
    need(not p.is_absolute() and str(p) == value and all(x not in ('.', '..') for x in p.parts)
         and ':' not in value, 'unsafe_path')
    return value

def allowed_file(value):
    safe_relative(value)
    need(value in FIXED or value.startswith('gbrain/'), 'unmanaged_private_path')
    return value

def no_links(path, private=False):
    p = Path(os.path.abspath(path))
    for part in (p, *p.parents):
        st = part.lstat()
        need(not stat.S_ISLNK(st.st_mode), 'symlink_refused')
    st = p.stat()
    need(stat.S_ISDIR(st.st_mode), 'directory_required')
    if private:
        need(st.st_uid == os.geteuid() and not st.st_mode & 0o077, 'private_directory_required')
    return p

def open_under(root, relative):
    """Walk using directory descriptors so a path swap cannot redirect a read."""
    parts = PurePosixPath(safe_relative(relative)).parts
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_fd
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            st = os.fstat(fd)
            need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid()
                 and not st.st_mode & 0o022, 'unsafe_file')
            return fd
        except BaseException:
            os.close(fd)
            raise
    finally:
        os.close(directory)

def signature(st):
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns

def transfer(root, relative, target=None, limit=MAX_BYTES):
    fd = open_under(root, relative)
    try:
        before = os.fstat(fd)
        need(before.st_size <= limit, 'size_limit')
        with contextlib.ExitStack() as stack:
            out = stack.enter_context(open(target, 'xb')) if target is not None else None
            if out:
                os.fchmod(out.fileno(), 0o600)
            digest = hashlib.sha256()
            count = 0
            while True:
                chunk = os.read(fd, min(1024 * 1024, limit - count + 1))
                if not chunk:
                    break
                count += len(chunk)
                need(count <= limit, 'size_limit')
                digest.update(chunk)
                if out:
                    out.write(chunk)
            need(signature(before) == signature(os.fstat(fd)) and count == before.st_size, 'file_changed')
            if out:
                out.flush()
                os.fsync(out.fileno())
            return {'bytes': count, 'sha256': digest.hexdigest()}
    finally:
        os.close(fd)

def small_read(root, relative, limit=MAX_MANIFEST):
    fd = open_under(root, relative)
    try:
        before = os.fstat(fd)
        need(before.st_size <= limit, 'size_limit')
        chunks, count = [], 0
        while True:
            data = os.read(fd, min(65536, limit - count + 1))
            if not data:
                break
            count += len(data)
            need(count <= limit, 'size_limit')
            chunks.append(data)
        need(signature(before) == signature(os.fstat(fd)) and count == before.st_size, 'file_changed')
        return b''.join(chunks)
    finally:
        os.close(fd)

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def write_new(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    sync_dir(path.parent)

def new_directory(target, forbidden=()):
    target = Path(os.path.abspath(target))
    no_links(target.parent, private=True)
    for root in forbidden:
        root = Path(os.path.abspath(root))
        need(target != root and root not in target.parents and target not in root.parents, 'overlapping_destination')
    target.mkdir(mode=0o700)  # exclusive, including refusal of dangling links
    sync_dir(target.parent)
    return target

def inventory(home):
    """Only selected managed state, never ~/.ssh, arbitrary sources, PGDATA or runtime."""
    no_links(home, private=True)
    names, directories = [], []
    native = home / 'gbrain'
    no_links(native)
    for base, dirs, files in os.walk(native, followlinks=False):
        for name in dirs:
            path = Path(base) / name
            st = path.lstat()
            need(stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode)
                 and st.st_uid == os.geteuid() and not st.st_mode & 0o022, 'unsafe_directory')
            directories.append(safe_relative(path.relative_to(home).as_posix()))
        for name in files:
            names.append(allowed_file((Path(base) / name).relative_to(home).as_posix()))
        need(len(names) + len(directories) <= MAX_FILES, 'file_count_limit')
    directories.append('gbrain')
    for name in FIXED:
        if os.path.lexists(home / name):
            names.append(name)
    need(set(REQUIRED).issubset(names), 'missing_private_state')
    need(len(names) + len(directories) <= MAX_FILES, 'file_count_limit')
    return sorted(names), sorted(directories)

def app_fingerprint(root=ROOT):
    """Fingerprint shipped execution code, not timestamps, git credentials or vendor binaries."""
    paths = [root / 'package.json', root / 'upstreams.lock.json']
    for name in ('src', 'scripts', 'migrations', 'web', 'compat'):
        paths.extend(p for p in (root / name).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    entries = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}
    return hashlib.sha256(encoded(entries)).hexdigest()

def manager():
    spec = importlib.util.spec_from_file_location('ultrabrain_managed_pg', ROOT / 'scripts/postgres.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

@contextlib.contextmanager
def managed_lock(pg):
    no_links(pg.HOME, private=True)
    fd = os.open(pg.HOME / '.postgres-manager.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid()
             and not st.st_mode & 0o077, 'unsafe_manager_lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)

def no_clients(pg):
    value = pg.pg('psql', '-X', '-tAc', "SELECT count(*) FROM pg_stat_activity WHERE datname='ultrabrain' "
                  "AND pid<>pg_backend_pid() AND backend_type='client backend'").stdout.strip()
    need(value == '0', 'stop_application_clients_first')

def create(pg, destination, *, consent=False, writers_stopped=False):
    need(consent is True and writers_stopped is True, 'explicit_private_backup_consent_required')
    home = no_links(pg.HOME, private=True)
    with managed_lock(pg):
        pg.compatible()
        no_clients(pg)
        names, dirs = inventory(home)
        target = new_directory(destination, (home, ROOT))
        write_new(target / 'INCOMPLETE', b'Incomplete recovery set; do not restore.\n')
        (target / 'private').mkdir(mode=0o700)
        rows, total = [], 0
        for index, name in enumerate(names):
            entry = transfer(home, name, target / 'private' / f'{index:06d}.bin', MAX_BYTES - total)
            total += entry['bytes']
            rows.append({'path': name, 'object': f'private/{index:06d}.bin', **entry})
        sync_dir(target / 'private')
        # Reuse the managed dump implementation; never copy live PGDATA.
        with contextlib.redirect_stdout(io.StringIO()):
            pg.backup(str(target / 'database'))
        db = load_json(small_read(target / 'database', 'manifest.json'))
        need(db.get('kind') == 'database-only' and db.get('format') == 2, 'unsupported_database_backup')
        database_manifest = transfer(target / 'database', 'manifest.json')
        dump = transfer(target / 'database', 'database.dump', limit=MAX_BYTES - total - database_manifest['bytes'])
        need(dump['sha256'] == db.get('dump_sha256'), 'database_checksum_mismatch')
        names_after, dirs_after = inventory(home)
        need(names_after == names and dirs_after == dirs, 'source_inventory_changed')
        for row in rows:
            need(transfer(home, row['path']) == {k: row[k] for k in ('bytes', 'sha256')}, 'private_state_changed')
        no_clients(pg)
        value = {'format': 1, 'kind': 'ultrabrain-recovery-set', 'encrypted': False,
                 'consistency': 'operator-declared writers stopped; inventory rechecked; not an atomic cross-store snapshot',
                 'application_sha256': app_fingerprint(), 'upstreams': pg.LOCK, 'postgres': pg.read_runtime(),
                 'private_files': rows, 'private_directories': dirs,
                 'database': {'dump': dump, 'manifest': database_manifest},
                 'excluded': EXCLUDED, 'activation': 'manual; stage and database restore never apply old configuration'}
        raw = encoded(value)
        need(len(raw) <= MAX_MANIFEST, 'manifest_limit')
        write_new(target / 'manifest.json', raw)
        (target / 'INCOMPLETE').unlink()
        sync_dir(target)
        return {'created': True, 'manifest_sha256': hashlib.sha256(raw).hexdigest(),
                'private_files': len(rows), 'private_bytes': total, 'encrypted': False,
                'note': 'Store manifest SHA separately. Private set includes credentials; do not publish.'}

def verify(directory, expected):
    root = no_links(directory, private=True)
    need(isinstance(expected, str) and HEX.fullmatch(expected), 'trusted_manifest_sha_required')
    need(not os.path.lexists(root / 'INCOMPLETE'), 'incomplete_set')
    raw = small_read(root, 'manifest.json')
    need(hashlib.sha256(raw).hexdigest() == expected, 'manifest_checksum_mismatch')
    m = load_json(raw)
    need(isinstance(m, dict) and m.get('kind') == 'ultrabrain-recovery-set' and m.get('format') == 1
         and m.get('encrypted') is False, 'unsupported_recovery_format')
    rows, dirs = m.get('private_files'), m.get('private_directories')
    need(isinstance(rows, list) and isinstance(dirs, list) and len(rows) + len(dirs) <= MAX_FILES, 'invalid_inventory')
    paths, objects = set(), set()
    total = 0
    for index, row in enumerate(rows):
        need(isinstance(row, dict), 'invalid_inventory')
        name = allowed_file(row.get('path'))
        obj = f'private/{index:06d}.bin'
        need(name not in paths and row.get('object') == obj, 'duplicate_or_invalid_object')
        paths.add(name); objects.add(obj)
        need(type(row.get('bytes')) is int and 0 <= row['bytes'] <= MAX_BYTES
             and isinstance(row.get('sha256'), str) and HEX.fullmatch(row['sha256']), 'invalid_inventory')
        total += row['bytes']
        need(total <= MAX_BYTES, 'size_limit')
        need(transfer(root, obj, limit=row['bytes']) == {k: row[k] for k in ('bytes', 'sha256')}, 'file_checksum_mismatch')
    need(set(REQUIRED).issubset(paths), 'missing_private_state')
    need(all(isinstance(x, str) for x in dirs) and len(dirs) == len(set(dirs)), 'duplicate_directory')
    for name in dirs:
        safe_relative(name)
        need(name == 'gbrain' or name.startswith('gbrain/'), 'unmanaged_directory')
        need(name not in paths and not any(parent.as_posix() in paths for parent in PurePosixPath(name).parents), 'path_collision')
    for name in paths:
        need(not any(parent.as_posix() in paths for parent in PurePosixPath(name).parents), 'path_collision')
    need(set(os.listdir(root)) == {'manifest.json', 'database', 'private'}, 'unexpected_recovery_files')
    no_links(root / 'private', private=True)
    need(set(os.listdir(root / 'private')) == {PurePosixPath(x).name for x in objects}, 'unexpected_recovery_files')
    no_links(root / 'database', private=True)
    need(set(os.listdir(root / 'database')) == {'manifest.json', 'database.dump'}, 'unexpected_database_files')
    need(isinstance(m.get('database'), dict), 'invalid_database_manifest')
    for filename, key in [('database.dump', 'dump'), ('manifest.json', 'manifest')]:
        entry = m['database'].get(key)
        need(isinstance(entry, dict) and type(entry.get('bytes')) is int and 0 <= entry['bytes'] <= MAX_BYTES
             and isinstance(entry.get('sha256'), str) and HEX.fullmatch(entry['sha256']), 'invalid_database_manifest')
        total += entry['bytes']
        need(total <= MAX_BYTES, 'size_limit')
        need(transfer(root / 'database', filename, limit=entry['bytes']) == entry, 'database_checksum_mismatch')
    db = load_json(small_read(root / 'database', 'manifest.json'))
    need(db.get('kind') == 'database-only' and db.get('format') == 2
         and db.get('dump_sha256') == m['database']['dump']['sha256']
         and db.get('postgres') == m.get('postgres'), 'database_manifest_mismatch')
    return m

def stage(directory, destination, expected):
    """Copy pinned bytes into an exclusive inactive directory; never restore configs in place."""
    root = no_links(directory, private=True)
    m = verify(root, expected)
    dest = new_directory(destination, (root, ROOT, manager().HOME))
    write_new(dest / 'INCOMPLETE', b'Incomplete staging; never activate.\n')
    for name in ('database', 'private-state'):
        (dest / name).mkdir(mode=0o700)
    for name in m['private_directories']:
        (dest / 'private-state' / name).mkdir(mode=0o700, parents=True, exist_ok=True)
    for row in m['private_files']:
        path = dest / 'private-state' / row['path']
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        need(transfer(root, row['object'], path, row['bytes']) == {k: row[k] for k in ('bytes', 'sha256')}, 'file_changed')
    for filename, key in [('database.dump', 'dump'), ('manifest.json', 'manifest')]:
        need(transfer(root / 'database', filename, dest / 'database' / filename,
                      m['database'][key]['bytes']) == m['database'][key], 'file_changed')
    # Preserve the exact manifest under the pinned expected digest, not a reserialization.
    raw = small_read(root, 'manifest.json')
    need(hashlib.sha256(raw).hexdigest() == expected, 'manifest_checksum_mismatch')
    write_new(dest / 'source-manifest.json', raw)
    write_new(dest / 'STAGED-NOT-ACTIVE', b'Private files are inactive evidence. Do not point ULTRABRAIN_HOME here.\n')
    for base, _, _ in os.walk(dest, topdown=False):
        sync_dir(Path(base))
    (dest / 'INCOMPLETE').unlink(); sync_dir(dest)
    return {'staged': True, 'configuration_applied': False, 'services_started': False, 'files': len(m['private_files'])}

def restore_database(pg, directory, expected, database, trust_source=False):
    need(trust_source is True, 'backup_origin_trust_required')
    need(isinstance(database, str) and re.fullmatch(r'ub_restore_[a-z0-9_]{1,40}', database), 'invalid_restore_database')
    m = verify(directory, expected)
    need(m.get('application_sha256') == app_fingerprint() and m.get('upstreams') == pg.LOCK
         and m.get('postgres') == pg.read_runtime(), 'recovery_runtime_mismatch')
    with managed_lock(pg):
        # Recopy and revalidate the dump into private local staging before SQL execution.
        with tempfile.TemporaryDirectory(prefix='recovery-', dir=pg.HOME / 'postgres') as temp:
            for filename, key in [('database.dump', 'dump'), ('manifest.json', 'manifest')]:
                entry = m['database'][key]
                need(transfer(Path(directory) / 'database', filename, Path(temp) / filename, entry['bytes']) == entry, 'file_changed')
            with contextlib.redirect_stdout(io.StringIO()):
                pg.restore_new(temp, database)
    return {'restored_database': database, 'original_unchanged': True, 'configuration_applied': False,
            'services_started': False, 'note': 'Inspect recovered data before manual cutover; source credentials were not applied.'}

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    commands = p.add_subparsers(dest='command', required=True)
    c = commands.add_parser('create'); c.add_argument('--destination', required=True)
    c.add_argument('--include-private-state', action='store_true'); c.add_argument('--writers-stopped', action='store_true')
    for cmd in ('verify', 'stage', 'restore-database'):
        sub = commands.add_parser(cmd); sub.add_argument('--directory', required=True); sub.add_argument('--expected-sha', required=True)
        if cmd == 'stage': sub.add_argument('--destination', required=True)
        if cmd == 'restore-database':
            sub.add_argument('--database', required=True); sub.add_argument('--trust-source', action='store_true')
    a = p.parse_args(argv)
    try:
        need(os.geteuid() != 0, 'ordinary_linux_user_required')
        os.umask(0o077)
        if a.command == 'create':
            result = create(manager(), a.destination, consent=a.include_private_state, writers_stopped=a.writers_stopped)
        elif a.command == 'verify':
            m = verify(a.directory, a.expected_sha)
            result = {'verified': True, 'private_files': len(m['private_files']), 'encrypted': False,
                      'source_authenticity': 'only as trustworthy as your separately retained SHA', 'excluded': m['excluded']}
        elif a.command == 'stage': result = stage(a.directory, a.destination, a.expected_sha)
        else: result = restore_database(manager(), a.directory, a.expected_sha, a.database, a.trust_source)
        print(json.dumps({'ok': True, 'result': result})); return 0
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e) if isinstance(e, RecoveryError) else 'recovery_failed',
                          'note': 'No automatic cleanup or overwrite. Failed restore may leave a new partial database.'})); return 1

if __name__ == '__main__':
    sys.exit(main())
