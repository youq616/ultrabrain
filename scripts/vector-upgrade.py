#!/usr/bin/env python3
"""Host-only, explicit SQL extension upgrade for the managed primary database.

No arbitrary SQL, extension name, target version or remote database is accepted.
Application logins are fenced; existing connections are never terminated.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location('ultrabrain_postgres', Path(__file__).with_name('postgres.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value):
        raise RuntimeError('Expected a stable x.y.z extension version')
    return tuple(map(int, value.split('.')))


def execute(sql, database='postgres'):
    return m.pg('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-tA', '-d', database, '-c', sql).stdout.strip()


def query(sql, database='postgres'):
    return json.loads(execute(sql, database))


def marker_path():
    return m.HOME / 'postgres/vector-maintenance.json'


def sync_parent(path):
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def marker_write(value):
    m.private_write(marker_path(), json.dumps(value, indent=2) + '\n')
    sync_parent(marker_path())


def marker_remove():
    marker_path().unlink(missing_ok=True)
    sync_parent(marker_path())


def identity():
    row = query("SELECT json_build_object('data_directory',current_setting('data_directory'),"
                "'database_oid',(SELECT oid FROM pg_database WHERE datname='ultrabrain'),"
                "'application_login',(SELECT rolcanlogin FROM pg_roles WHERE rolname='ultrabrain'),"
                "'server_version',current_setting('server_version'))::text")
    if Path(row['data_directory']).resolve() != m.DATA.resolve() or row['database_oid'] is None:
        raise RuntimeError('Connected database is not the managed cluster')
    return {'database_oid': row['database_oid'],
            'cluster_sha256': hashlib.sha256(str(m.DATA.resolve()).encode()).hexdigest(),
            'application_login': row['application_login'], 'server_version': row['server_version']}


def plan():
    active = m.read_runtime()
    m.validate_runtime(active)
    m.compatible()
    if any(active[k] != m.EXPECTED[k] for k in ('version', 'postgres_revision', 'pgvector_revision')):
        raise RuntimeError('Activate the reviewed, pinned runtime before upgrading the SQL extension')
    target = m.VECTOR['version']
    version(target)
    server = identity()
    if server['server_version'].split(' ')[0] != active['version']:
        raise RuntimeError('Running PostgreSQL version differs from the bound runtime')
    row = query("SELECT json_build_object('installed',(SELECT extversion FROM pg_extension WHERE extname='vector'),"
                "'default_version',(SELECT default_version FROM pg_available_extensions WHERE name='vector'),"
                f"'target_available',EXISTS(SELECT 1 FROM pg_available_extension_versions WHERE name='vector' AND version='{target}'))::text", 'ultrabrain')
    installed = row['installed']
    if version(installed) > version(target):
        raise RuntimeError('Extension downgrade refused; use the compatible application/runtime release')
    if row['default_version'] != target or not row['target_available']:
        raise RuntimeError('Installed extension scripts do not match the pinned target version')
    path = None
    if installed != target:
        path = query("SELECT coalesce((SELECT to_json(path) FROM pg_extension_update_paths('vector') "
                     f"WHERE source='{installed}' AND target='{target}'),'null'::json)::text", 'ultrabrain')
        if not path:
            raise RuntimeError('No declared extension SQL update path to the pinned target')
    return {'format': 1, 'extension': 'vector', 'installed': installed, 'target': target,
            'update_required': installed != target, 'update_path': path, **server,
            'runtime': active, 'maintenance_pending': marker_path().exists(),
            'scope': 'SQL extension objects only; binary activation and PostgreSQL major upgrade are separate'}


def ensure_idle():
    count = int(execute("SELECT count(*) FROM pg_stat_activity WHERE datname='ultrabrain'"))
    if count:
        raise RuntimeError('Stop all MCP/worker/application connections first; no session was terminated')


def capture_backup(destination, current):
    target = (Path(destination).resolve() if destination else
              m.HOME / 'backups' / ('vector-' + time.strftime('%Y%m%d-%H%M%S-') + secrets.token_hex(3)))
    if target.exists():
        raise RuntimeError('Backup destination already exists; every upgrade requires a fresh backup')
    m.private_dir(target)
    try:
        # The app role is NOLOGIN. This host-only dump uses the managed admin, not an MCP token.
        m.pg('pg_dump', '-d', 'ultrabrain', '-Fc', '--no-owner', '--no-acl', '-f', target / 'database.dump')
        manifest = {'kind': 'database-only', 'format': 2, 'postgres': m.read_runtime(),
                    'gbrain': m.LOCK['gbrain']['revision'], 'dump_sha256': m.file_hash(target / 'database.dump'),
                    'extension_versions': {'vector': current['installed']}, 'purpose': 'before-vector-sql-upgrade',
                    'separately_required': ['private configuration and secrets', 'source repositories', 'native attachment/blob storage']}
        m.private_write(target / 'manifest.json', json.dumps(manifest, indent=2) + '\n')
        return target
    except Exception:
        m.private_write(target / 'INCOMPLETE', 'Backup failed. Do not restore this directory.\n')
        raise


def upgrade(expected_version, confirm=False, destination=None):
    if not confirm:
        raise RuntimeError('Explicit --confirm-maintenance is required; stop clients before running')
    version(expected_version)
    current = plan()
    if current['installed'] != expected_version:
        raise RuntimeError('Installed extension version changed; read vector-plan again')
    if current['maintenance_pending']:
        raise RuntimeError('An interrupted maintenance marker exists; inspect vector-plan and use vector-recover')
    if not current['update_required']:
        return {'changed': False, 'version': current['installed'], 'reason': 'already_pinned'}
    if current['application_login'] is not True:
        raise RuntimeError('Application login was already disabled; refusing to override operator policy')
    marker = {'format': 1, 'operation': 'vector-sql-upgrade', 'previous_login': True,
              'database_oid': current['database_oid'], 'cluster_sha256': current['cluster_sha256'],
              'from': current['installed'], 'to': current['target'], 'phase': 'prepared'}
    marker_write(marker)
    fenced = False
    try:
        # Set the flag first: a response can be lost after the server commits NOLOGIN.
        fenced = True
        execute('ALTER ROLE ultrabrain NOLOGIN')
        marker_write({**marker, 'phase': 'logins-fenced'})
        ensure_idle()
        backup = capture_backup(destination, current)
        marker_write({**marker, 'phase': 'backed-up', 'backup': str(backup)})
        ensure_idle()
        target = current['target']  # stable numeric version, validated above
        execute(f"""BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
DO $check$ BEGIN
 IF (SELECT extversion FROM pg_extension WHERE extname='vector') IS DISTINCT FROM '{expected_version}' THEN
  RAISE EXCEPTION 'Extension changed after preflight'; END IF;
 IF (SELECT rolcanlogin FROM pg_roles WHERE rolname='ultrabrain') THEN
  RAISE EXCEPTION 'Application login fence was removed'; END IF;
END $check$;
ALTER EXTENSION vector UPDATE TO '{target}';
DO $check$ BEGIN
 IF (SELECT extversion FROM pg_extension WHERE extname='vector') IS DISTINCT FROM '{target}' THEN
  RAISE EXCEPTION 'Extension target mismatch'; END IF;
END $check$;
COMMIT;""", 'ultrabrain')
        return {'changed': True, 'from': expected_version, 'version': target, 'backup': str(backup),
                'scope': current['scope'], 'application_logins_restored': True}
    finally:
        # Never restore by dropping/recreating the extension. Failed SQL is transactional.
        # A hard kill may leave NOLOGIN + marker; vector-recover restores only the login state.
        if fenced:
            execute('ALTER ROLE ultrabrain LOGIN')
        marker_remove()


def recover(confirm=False):
    if not confirm:
        raise RuntimeError('Explicit --confirm-maintenance is required to recover interrupted login fencing')
    path = marker_path()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        import stat
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077 or st.st_size > 65536:
            raise RuntimeError('Unsafe maintenance marker')
        with os.fdopen(fd, 'r', closefd=False) as stream:
            marker = json.load(stream)
    finally:
        os.close(fd)
    server = identity()
    if (marker.get('format') != 1 or marker.get('operation') != 'vector-sql-upgrade' or
            marker.get('previous_login') is not True or
            any(marker.get(k) != server[k] for k in ('database_oid', 'cluster_sha256'))):
        raise RuntimeError('Maintenance marker does not identify this managed database')
    installed = execute("SELECT extversion FROM pg_extension WHERE extname='vector'", 'ultrabrain')
    if installed not in (marker.get('from'), marker.get('to')):
        raise RuntimeError('Unexpected extension state; inspect before restoring application logins')
    execute('ALTER ROLE ultrabrain LOGIN')
    marker_remove()
    return {'recovered_login': True, 'version': installed, 'schema_changed': False,
            'scope': 'Login recovery only, not a database rollback'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('vector-plan')
    p = sub.add_parser('vector-upgrade')
    p.add_argument('--from-version', required=True)
    p.add_argument('--backup-destination')
    p.add_argument('--confirm-maintenance', action='store_true')
    p = sub.add_parser('vector-recover')
    p.add_argument('--confirm-maintenance', action='store_true')
    a = parser.parse_args()
    if os.geteuid() == 0:
        raise RuntimeError('Run as the unprivileged service account, not root')
    os.umask(0o077)
    m.private_dir(m.HOME)
    with (m.HOME / '.postgres-manager.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if a.command == 'vector-plan':
            report = plan()
        elif a.command == 'vector-upgrade':
            report = upgrade(a.from_version, a.confirm_maintenance, a.backup_destination)
        else:
            report = recover(a.confirm_maintenance)
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Vector maintenance failed: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        raise SystemExit(1)
