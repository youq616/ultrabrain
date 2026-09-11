#!/usr/bin/env python3
"""Local operator token provisioning. Never exposed as an MCP tool or arbitrary SQL API."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ultrabrain_postgres', ROOT / 'scripts/postgres.py')
postgres = importlib.util.module_from_spec(spec)
spec.loader.exec_module(postgres)


def label(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}', value):
        raise ValueError('Name must contain 1..80 ASCII letters, digits, dot, underscore or hyphen')
    return value


def source(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9-]{1,32}', value):
        raise ValueError('Source must contain 1..32 lowercase ASCII letters, digits or hyphens')
    return value


def sql_literal(value):
    # Used only for validated identifiers, generated hashes and JSON constructed here.
    if not isinstance(value, str) or '\x00' in value:
        raise ValueError('Invalid SQL literal')
    return "'" + value.replace("'", "''") + "'"


def execute(query):
    # The app role is sufficient. No PostgreSQL superuser credential is used here.
    return postgres.pg('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', query,
                       admin=False).stdout.strip()


def revoke_hash(digest):
    if not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid token hash')
    execute('UPDATE access_tokens SET revoked_at=now() WHERE token_hash=' + sql_literal(digest))


def create(name, source_id, writable=False):
    label(name); source(source_id)
    if type(writable) is not bool:
        raise ValueError('Write permission must be explicitly boolean')
    if execute('SELECT count(*) FROM sources WHERE id=' + sql_literal(source_id)) != '1':
        raise RuntimeError('Source does not exist; create and authorize it using the native source management first')
    if execute('SELECT count(*) FROM access_tokens WHERE name=' + sql_literal(name)) != '0':
        raise RuntimeError('This token name already exists; use a new name instead of overwriting credentials')
    directory = postgres.HOME / 'mcp-tokens'
    postgres.private_dir(directory)
    path = directory / (name + '.token')
    token = 'gbrain_' + secrets.token_hex(32)
    digest = hashlib.sha256(token.encode()).hexdigest()
    scopes = ['read', 'write'] if writable else ['read']
    permissions = json.dumps({'source_id': source_id, 'takes_holders': ['world']}, separators=(',', ':'))
    # Reserve the destination before touching the database, with no symlink following
    # or silent replacement. This file contains a bearer secret and remains 0600.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    inserted = False
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(token + '\n'); stream.flush(); os.fsync(stream.fileno())
        scope_sql = 'ARRAY[' + ','.join(sql_literal(x) for x in scopes) + ']::text[]'
        query = ('INSERT INTO access_tokens(name,token_hash,scopes,permissions) SELECT '
                 + ','.join([sql_literal(name), sql_literal(digest), scope_sql, sql_literal(permissions) + '::jsonb'])
                 + ' WHERE NOT EXISTS (SELECT 1 FROM access_tokens WHERE name=' + sql_literal(name)
                 + ') RETURNING name')
        # A connection failure can leave commit acknowledgement ambiguous, so an
        # error attempts revocation by the new hash, never by someone else's name.
        inserted = True
        if execute(query) != name:
            raise RuntimeError('Token name was concurrently created; no credential was replaced')
        return {'created': True, 'name': name, 'source': source_id, 'scopes': scopes,
                'token_file': str(path), 'expiration': 'No automatic expiry configured; revoke explicitly',
                'visibility': 'world pages within the source grant; host-private pages remain private'}
    except Exception:
        if inserted:
            try:
                revoke_hash(digest)
            except Exception:
                # Do not print token, hash, SQL, or database connection diagnostics.
                print('Token cleanup could not be confirmed; inspect local token metadata before retrying.', file=sys.stderr)
        path.unlink(missing_ok=True)
        raise


def revoke(name):
    label(name)
    query = ('WITH revoked AS (UPDATE access_tokens SET revoked_at=now() WHERE name='
             + sql_literal(name) + ' AND revoked_at IS NULL RETURNING 1) SELECT count(*) FROM revoked')
    count = execute(query)
    if not count.isdigit():
        raise RuntimeError('Unexpected token revocation response')
    # A token file is intentionally not deleted here; revocation is server-side and
    # applies even to copies held by remote clients. Operator controls file disposal.
    return {'name': name, 'revoked_count': int(count), 'token_files_deleted': False}


def list_tokens():
    query = """SELECT COALESCE(json_agg(json_build_object(
        'name',name,'source',permissions->>'source_id','scopes',scopes,
        'revoked',revoked_at IS NOT NULL) ORDER BY name),'[]'::json)::text FROM access_tokens"""
    return json.loads(execute(query))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    p = actions.add_parser('create')
    p.add_argument('--name', required=True)
    p.add_argument('--source', required=True)
    p.add_argument('--write', action='store_true', help='Explicitly grant read + write; default is read-only')
    p = actions.add_parser('revoke')
    p.add_argument('--name', required=True, help='Revoke all active tokens with this exact operator label')
    actions.add_parser('list')
    args = parser.parse_args()
    if os.geteuid() == 0:
        parser.error('Use the same unprivileged Linux account that owns Ultrabrain')
    os.umask(0o077)
    postgres.private_dir(postgres.HOME)
    postgres.compatible()
    with (postgres.HOME / '.mcp-token-manager.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action == 'create':
            result = create(args.name, args.source, args.write)
        elif args.action == 'revoke':
            result = revoke(args.name)
        else:
            result = list_tokens()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError):
        print('Token operation failed. Check private paths, source, duplicate names and database readiness; no credentials are printed.', file=sys.stderr)
        raise SystemExit(1)
