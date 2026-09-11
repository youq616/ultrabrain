#!/usr/bin/env python3
"""Manage a private, native PostgreSQL cluster without Docker or an external database."""
import argparse
import hashlib
import fcntl
import json
import os
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote
ROOT = Path(__file__).resolve().parents[1]
HOME = Path(os.environ.get('ULTRABRAIN_HOME', Path.home() / '.local/share/ultrabrain')).resolve()
LOCK = json.loads((ROOT / 'upstreams.lock.json').read_text())['projects']
PG = LOCK['postgres']
VECTOR = LOCK['pgvector']
EXPECTED = {'version': PG['version'], 'postgres_revision': PG['revision'],
    'pgvector_revision': VECTOR['revision'],
    'directory': f"postgres-{PG['version']}-{PG['revision'][:12]}-pgvector-{VECTOR['revision'][:12]}"}
RUNTIME_STATE = HOME / 'postgres/runtime.json'
DATA = HOME / 'postgres/data'
STATE = HOME / 'postgres/state.json'

def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o077:
        raise RuntimeError(f'{path} must be an owner-only directory (0700)')

def private_write(path, data):
    private_dir(path.parent)
    temp = path.with_name(path.name + '.' + secrets.token_hex(6))
    try:
        with open(temp, 'x', encoding='utf8') as f:
            os.chmod(temp, 0o600); f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists(): temp.unlink()

def state():
    if STATE.is_symlink() or STATE.stat().st_uid != os.geteuid() or STATE.stat().st_mode & 0o077:
        raise RuntimeError('state.json must have mode 0600')
    return json.loads(STATE.read_text())

def read_runtime():
    if RUNTIME_STATE.exists():
        if RUNTIME_STATE.is_symlink() or RUNTIME_STATE.stat().st_uid != os.geteuid() or RUNTIME_STATE.stat().st_mode & 0o077:
            raise RuntimeError('Runtime binding must be an owner-only regular file')
        value = json.loads(RUNTIME_STATE.read_text())
    else:
        # One-time compatibility for the unreleased v0.1 bootstrap. Never infer an
        # old runtime from a NEW lock: the complete build marker must match both pins.
        old = f"postgres-{PG['version']}-{PG['revision'][:12]}"
        marker = HOME / 'runtime' / old / '.ultrabrain-build'
        if marker.is_file() and marker.read_text().strip() == PG['revision'] + ':' + VECTOR['revision']:
            value = dict(EXPECTED, directory=old)
        elif not (DATA / 'PG_VERSION').exists():
            value = EXPECTED
        else:
            raise RuntimeError('Missing active runtime binding; initialize with the previous release before changing pins')
    if not re.fullmatch(r'[0-9]+\.[0-9]+', value['version']) or not all(
        re.fullmatch(r'[a-f0-9]{40}',value[k]) for k in ('postgres_revision','pgvector_revision')):
        raise RuntimeError('Invalid runtime binding')
    base = f"postgres-{value['version']}-{value['postgres_revision'][:12]}"
    if value['directory'] not in (base,base+'-pgvector-'+value['pgvector_revision'][:12]):
        raise RuntimeError('Invalid runtime directory')
    return value

def prefix(value=None):
    return HOME / 'runtime' / (value or read_runtime())['directory']

def validate_runtime(value):
    root = prefix(value)
    marker = root / '.ultrabrain-build'
    if not marker.is_file() or marker.read_text().strip() != value['postgres_revision']+':'+value['pgvector_revision']:
        raise RuntimeError('Pinned runtime is missing or incomplete; run scripts/build-postgres.sh')
    if root.is_symlink() or root.stat().st_uid != os.geteuid() or root.stat().st_mode & 0o077:
        raise RuntimeError('Runtime directory must be owned and writable only by the service user')
    return root

def binary(name):
    root = validate_runtime(read_runtime())
    path = root / 'bin' / name
    if not path.is_file(): raise RuntimeError('Pinned PostgreSQL executable is missing')
    return str(path)

def native_env(**overrides):
    # Select this release's libpq, never a potentially incompatible system copy.
    env = {k:v for k,v in os.environ.items() if k not in
        ('PGSERVICE','PGSERVICEFILE','PGOPTIONS','LD_PRELOAD','LD_AUDIT','LD_LIBRARY_PATH')}
    env['LD_LIBRARY_PATH'] = str(prefix() / 'lib')
    return dict(env, **overrides)

def compatible():
    actual = (DATA / 'PG_VERSION').read_text().strip()
    expected = read_runtime()['version'].split('.')[0]
    if actual != expected:
        raise RuntimeError(f'Data major {actual} differs from active binary major {expected}; use a reviewed major migration')

def activate_runtime():
    validate_runtime(EXPECTED)
    if (DATA / 'PG_VERSION').exists():
        if (DATA / 'PG_VERSION').read_text().strip() != PG['version'].split('.')[0]:
            raise RuntimeError('Cross-major activation refused; restore or pg_upgrade into a separate cluster first')
        if status(): raise RuntimeError('Stop MCP clients and PostgreSQL before activating a new runtime')
    private_write(RUNTIME_STATE, json.dumps(EXPECTED, indent=2)+'\n')
    print('Pinned runtime activated. No schema or data was changed; next start uses this runtime.')

def pg(name, *args, admin=True, capture=True):
    s = state()
    role = 'ultrabrain_admin' if admin else 'ultrabrain'
    password = s['admin_password' if admin else 'app_password']
    env = native_env(PGHOST='127.0.0.1', PGHOSTADDR='127.0.0.1', PGPORT=str(s['port']), PGUSER=role,
        PGDATABASE='postgres' if admin else 'ultrabrain', PGPASSWORD=password, PGCONNECT_TIMEOUT='10')
    # No connection URL/password in arguments, process logs or printed commands.
    return subprocess.run([binary(name), *map(str, args)], env=env,
        check=True, text=True, stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None)

def status():
    compatible()
    result = subprocess.run([binary('pg_ctl'), '-D', str(DATA), 'status'], env=native_env(), capture_output=True, text=True)
    return result.returncode == 0

def start():
    compatible()
    if status(): return
    subprocess.run([binary('pg_ctl'), '-D', str(DATA), '-l', str(HOME / 'postgres/server.log'),
        '-w', '-t', '60', 'start'], env=native_env(), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

def stop():
    compatible()
    if status():
        subprocess.run([binary('pg_ctl'), '-D', str(DATA), '-m', 'fast', '-w', 'stop'],
            env=native_env(), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

def init(port):
    private_dir(HOME); private_dir(HOME / 'postgres'); private_dir(HOME / 'postgres/socket')
    if not STATE.exists():
        if DATA.exists(): raise RuntimeError('Existing PGDATA without state; refusing to replace credentials')
        private_write(STATE, json.dumps({'port': port, 'admin_password': secrets.token_urlsafe(36),
            'app_password': secrets.token_urlsafe(36)}) + '\n')
    s = state()
    active = read_runtime()
    validate_runtime(active)
    if any(active[k] != EXPECTED[k] for k in ('version','postgres_revision','pgvector_revision')):
        raise RuntimeError('Installed source pins differ from active runtime. Stop services, build, and run db activate-runtime first')
    if not RUNTIME_STATE.exists(): private_write(RUNTIME_STATE, json.dumps(active, indent=2)+'\n')
    if not (DATA / 'PG_VERSION').exists():
        password_file = HOME / 'postgres/init-password'
        private_write(password_file, s['admin_password'])
        try:
            subprocess.run([binary('initdb'), '-D', str(DATA), '-U', 'ultrabrain_admin',
                '--pwfile', str(password_file), '--auth-local=scram-sha-256',
                '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C'],
                env=native_env(), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        finally: password_file.unlink(missing_ok=True)
        # Quote paths as PostgreSQL string literals; no interpolation into shell commands.
        socket = str(HOME / 'postgres/socket').replace("'", "''")
        with (DATA / 'postgresql.conf').open('a') as f:
            f.write(f"\nlisten_addresses = '127.0.0.1'\nport = {s['port']}\n"
                    f"unix_socket_directories = '{socket}'\npassword_encryption = 'scram-sha-256'\n"
                    "log_statement = 'none'\nlog_min_error_statement = 'panic'\n")
    start()
    exists = pg('psql', '-X', '-tAc', "SELECT 1 FROM pg_roles WHERE rolname='ultrabrain'").stdout.strip()
    if not exists:
        # Password is generated locally and passed via stdin, never an SQL command-line argument.
        env = native_env(PGHOST='127.0.0.1', PGHOSTADDR='127.0.0.1', PGPORT=str(s['port']), PGUSER='ultrabrain_admin',
            PGDATABASE='postgres', PGPASSWORD=s['admin_password'])
        sql = f"CREATE ROLE ultrabrain LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '{s['app_password']}';"
        subprocess.run([binary('psql'), '-X', '-v', 'ON_ERROR_STOP=1'], input=sql, env=env,
            text=True, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    # Native GBrain migrations require BYPASSRLS. The application remains non-superuser;
    # client/source isolation is enforced by its operation layer, not per-client PG roles.
    pg('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'ALTER ROLE ultrabrain BYPASSRLS')
    exists = pg('psql', '-X', '-tAc', "SELECT 1 FROM pg_database WHERE datname='ultrabrain'").stdout.strip()
    if not exists: pg('createdb', '-O', 'ultrabrain', 'ultrabrain')
    pg('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'ultrabrain', '-c',
        'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;')
    pg('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'ultrabrain', '-f', ROOT / 'scripts/admin-bootstrap.sql')
    config_path = HOME / 'gbrain/config.json'
    url = f"postgresql://ultrabrain:{quote(s['app_password'], safe='')}@127.0.0.1:{s['port']}/ultrabrain"
    if config_path.exists():
        config = json.loads(config_path.read_text())
        if config.get('engine') != 'postgres' or config.get('database_url') != url:
            raise RuntimeError('Existing config points elsewhere; refusing to overwrite it')
    else:
        private_write(config_path, json.dumps({'engine': 'postgres', 'database_url': url,
            'embedding_model': 'openai:text-embedding-3-small', 'embedding_dimensions': 1536}, indent=2) + '\n')
    print('Private PostgreSQL initialized; runtime role is not a superuser. No model key is configured.')

def file_hash(path):
    with Path(path).open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()

def backup(destination=None):
    compatible()
    target = Path(destination).resolve() if destination else HOME / 'backups' / (time.strftime('%Y%m%d-%H%M%S-') + secrets.token_hex(3))
    if target.exists(): raise RuntimeError('Backup destination already exists')
    private_dir(target)
    try:
        pg('pg_dump', '-Fc', '--no-owner', '--no-acl', '-f', target / 'database.dump', admin=False)
        # Config, credentials, attachments and source files are deliberately not claimed to be in pg_dump.
        private_write(target / 'manifest.json', json.dumps({'kind': 'database-only',
            'postgres': read_runtime(), 'gbrain': LOCK['gbrain']['revision'],
            'format': 2, 'dump_sha256': file_hash(target / 'database.dump'),
            'separately_required': ['private configuration and secrets', 'source repositories', 'native attachment/blob storage'],
            'restore': 'restore-new creates a different database; existing brain is untouched'}, indent=2) + '\n')
        print(target)
    except Exception:
        private_write(target / 'INCOMPLETE', 'Backup failed. Do not restore this directory.\n')
        raise

def restore_new(directory, database):
    if not re.fullmatch(r'ub_restore_[a-z0-9_]{1,40}', database):
        raise RuntimeError('Destination must match ub_restore_[a-z0-9_]{1,40}')
    path = Path(directory).resolve()
    if (path / 'INCOMPLETE').exists(): raise RuntimeError('Incomplete backup refused')
    manifest = json.loads((path / 'manifest.json').read_text())
    if manifest.get('kind') != 'database-only' or manifest.get('format') != 2:
        raise RuntimeError('Unsupported backup format; use the release that created the backup')
    expected_hash = manifest.get('dump_sha256')
    if not isinstance(expected_hash,str) or not re.fullmatch(r'[a-f0-9]{64}',expected_hash) or file_hash(path / 'database.dump') != expected_hash:
        raise RuntimeError('Backup checksum mismatch; nothing was restored')
    if int(manifest['postgres']['version'].split('.')[0]) > int(read_runtime()['version'].split('.')[0]):
        raise RuntimeError('Cannot restore a newer PostgreSQL major into an older runtime')
    # createdb fails if a database exists. Never DROP, overwrite or switch the running brain.
    pg('createdb', '-O', 'ultrabrain', database)
    pg('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c',
        'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;')
    # Event triggers are superuser-only. Restore application objects as the app role,
    # then recreate the one pinned administrative trigger from reviewed source.
    listing = pg('pg_restore', '--list', path / 'database.dump').stdout
    selected = '\n'.join(line for line in listing.splitlines() if ' EVENT TRIGGER ' not in line) + '\n'
    toc = HOME / 'postgres' / ('restore-toc-' + secrets.token_hex(6))
    private_write(toc, selected)
    try:
        pg('pg_restore', '--exit-on-error', '--no-owner', '--no-acl', '--no-comments', '--role=ultrabrain',
            '--use-list', toc, '-d', database, path / 'database.dump')
        pg('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', database, '-f', ROOT / 'scripts/admin-bootstrap.sql')
    finally:
        toc.unlink(missing_ok=True)
    print(f'Restored into {database}. Original database and application config are unchanged.')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('init'); p.add_argument('--port', type=int, default=65432)
    for cmd in ['start', 'stop', 'status', 'activate-runtime']: sub.add_parser(cmd)
    p = sub.add_parser('backup'); p.add_argument('--destination')
    p = sub.add_parser('restore-new'); p.add_argument('directory'); p.add_argument('--database', required=True)
    a = parser.parse_args()
    if os.geteuid() == 0: raise RuntimeError('Run as a dedicated, unprivileged Linux user, not root')
    os.umask(0o077); private_dir(HOME)
    with (HOME / '.postgres-manager.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if a.command == 'init':
            if not 1024 <= a.port <= 65535: raise RuntimeError('Port must be between 1024 and 65535')
            init(a.port)
        elif a.command == 'activate-runtime': activate_runtime()
        elif a.command == 'start': start(); print('PostgreSQL is running.')
        elif a.command == 'stop': stop(); print('PostgreSQL is stopped.')
        elif a.command == 'status':
            running = status(); print('running' if running else 'stopped'); return 0 if running else 3
        elif a.command == 'backup': backup(a.destination)
        elif a.command == 'restore-new': restore_new(a.directory, a.database)
    return 0
if __name__ == '__main__':
    try: raise SystemExit(main())
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
        # subprocess stderr may contain SQL or connection info; never dump it by default.
        print(f'PostgreSQL manager failed: {str(e) if isinstance(e, RuntimeError) else type(e).__name__}', file=sys.stderr)
        raise SystemExit(1)
