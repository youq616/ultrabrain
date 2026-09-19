#!/usr/bin/env python3
"""Observe the selected live managed database's logical identity, without starting it.

Only the private Unix socket, a pinned psql executable, SCRAM and OS peer identity
are accepted. Keep the read-only SQL session alive while verifying its actual
backend against the selected postmaster. No console token or memory is read.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
from contextlib import AbstractContextManager
import importlib.util
import json
import math
import os
from pathlib import Path
import pwd
import re
import selectors
import stat
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('identity_process', ROOT/'scripts/personal_ready_process.py')
PROCESS = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PROCESS)
PREFLIGHT, FS = PROCESS.PREFLIGHT, PROCESS.FS
need, IdentityError = PROCESS.need, PROCESS.ReadyError
NO_ACTIONS = {'services_started': False, 'services_stopped': False,
              'configuration_changed': False, 'model_called': False,
              'memory_read': False, 'credentials_returned': False,
              'application_ready': False, 'database_write_requested': False}
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
FIELDS = {'format', 'source_id', 'source_exists', 'instance_id', 'backend_pid',
          'database_port', 'database_name', 'database_user', 'database_session_user',
          'unix_socket', 'read_only', 'schema_ready'}
SQL = b"""BEGIN READ ONLY;
SET LOCAL statement_timeout='2s';
SET LOCAL lock_timeout='1s';
SELECT pg_catalog.row_to_json(q)::text FROM (SELECT
  1 AS format, :'source'::text AS source_id,
  EXISTS(SELECT 1 FROM public.sources WHERE id=:'source') AS source_exists,
  (SELECT instance_id::text FROM ultrabrain.instance_identity WHERE singleton) AS instance_id,
  pg_catalog.pg_backend_pid() AS backend_pid,
  pg_catalog.current_setting('port')::integer AS database_port,
  pg_catalog.current_database() AS database_name,
  current_user AS database_user, session_user AS database_session_user,
  pg_catalog.inet_server_addr() IS NULL AND pg_catalog.inet_client_addr() IS NULL AS unix_socket,
  pg_catalog.current_setting('transaction_read_only')='on' AS read_only,
  pg_catalog.current_schema()='public' AND
    pg_catalog.to_regclass('ultrabrain.personal_memories') IS NOT NULL AND
    pg_catalog.to_regclass('ultrabrain.personal_events') IS NOT NULL AND
    pg_catalog.to_regclass('ultrabrain.agent_registry') IS NOT NULL AND
    pg_catalog.to_regclass('ultrabrain.personal_consolidations') IS NOT NULL AND
    pg_catalog.to_regclass('ultrabrain.personal_documents') IS NOT NULL AND
    pg_catalog.to_regclass('ultrabrain.personal_document_fragments') IS NOT NULL AND
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='ultrabrain'
      AND table_name='personal_memories' AND column_name='actor_key') AS schema_ready
) q;
"""
END = b'ROLLBACK;\n\\echo ULTRABRAIN_IDENTITY_ROLLED_BACK\n\\q\n'
ACK = b'ULTRABRAIN_IDENTITY_ROLLED_BACK'


def remaining(deadline):
    value = deadline - time.monotonic()
    need(value > 0, 'identity_timeout')
    return value


def observation_deadline(caller=None):
    """Never extend a containing operation's monotonic deadline."""
    if caller is not None:
        need(type(caller) in (int, float) and math.isfinite(caller), 'invalid_identity_deadline')
    deadline = time.monotonic()+10
    if caller is not None:
        deadline = min(deadline, caller)
    remaining(deadline)
    return deadline


def platform_check():
    need(sys.platform == 'linux', 'server_requires_linux')
    need(0 < os.getuid() == os.geteuid(), 'use_ordinary_service_account')
    need(sys.version_info >= (3, 11), 'python_3_11_required')


def selection(home, source):
    home = FS.absolute(home)
    need(isinstance(source, str) and re.fullmatch('[a-z0-9-]{1,32}', source), 'invalid_source')
    # libpq splits host lists at commas; ld.so splits colon/semicolon lists and
    # expands dollar tokens. Conninfo quoting cannot disable these interpretations.
    need(not any(c in str(home) for c in ',:;$'), 'ambiguous_runtime_path')
    return home


def conninfo_value(value):
    return "'" + str(value).replace('\\', '\\\\').replace("'", "\\'") + "'"


def invocation(home, database, source, password):
    """No ambient PG/loader/startup settings, URLs, admin password or shell."""
    home = selection(home, source)
    peer = pwd.getpwuid(os.geteuid())
    need(peer.pw_uid == os.geteuid() and isinstance(peer.pw_name, str) and peer.pw_name
         and len(peer.pw_name) <= 256 and not any(ord(c) < 32 or ord(c) == 127 for c in peer.pw_name),
         'invalid_peer_account')
    prefix = home/'runtime'/database['runtime_directory']
    socket_directory = home/'postgres/socket'
    need(len(os.fsencode(str(socket_directory) + '/.s.PGSQL.' + str(database['port']))) < 108,
         'socket_path_too_long')
    values = {'host': str(socket_directory), 'port': str(database['port']),
              'dbname': 'ultrabrain', 'user': 'ultrabrain', 'requirepeer': peer.pw_name,
              'require_auth': 'scram-sha-256', 'sslmode': 'disable', 'gssencmode': 'disable',
              'connect_timeout': '3', 'application_name': 'ultrabrain-personal-identity'}
    command = [str(prefix/'bin/psql'), '-X', '-A', '-t', '-q', '-w', '-v', 'ON_ERROR_STOP=1',
               '-v', 'source='+source, '--dbname', ' '.join(k+'='+conninfo_value(v) for k,v in values.items())]
    environment = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'PGPASSWORD': password,
                   'PGPASSFILE': '/dev/null', 'LD_LIBRARY_PATH': str(prefix/'lib'),
                   'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=2000 '
                                '-c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000'}
    return command, environment


class PsqlSession(AbstractContextManager):
    """A bounded two-way dialogue; never close the backend before procfs binding."""
    def __init__(self, command, environment, deadline):
        self.deadline, self.output, self.counts = deadline, b'', {'out': 0, 'err': 0}
        remaining(deadline)
        self.selector = selectors.DefaultSelector()
        try:
            self.child = subprocess.Popen(command, env=environment, cwd='/', stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                          close_fds=True, start_new_session=True)
        except BaseException:
            self.selector.close()
            raise
        try:
            for stream in (self.child.stdin, self.child.stdout, self.child.stderr):
                os.set_blocking(stream.fileno(), False)
            self.selector.register(self.child.stdout, selectors.EVENT_READ, 'out')
            self.selector.register(self.child.stderr, selectors.EVENT_READ, 'err')
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def send(self, raw):
        need(isinstance(raw, bytes) and len(raw) <= 4096, 'invalid_identity_request')
        with selectors.DefaultSelector() as writable:
            writable.register(self.child.stdin, selectors.EVENT_WRITE)
            sent = 0
            while sent < len(raw):
                need(writable.select(remaining(self.deadline)), 'identity_timeout')
                try:
                    count = os.write(self.child.stdin.fileno(), raw[sent:])
                except BlockingIOError:
                    continue
                need(count > 0, 'database_probe_failed')
                sent += count

    def pump(self):
        need(self.selector.get_map(), 'database_probe_failed')
        events = self.selector.select(remaining(self.deadline))
        need(events, 'identity_timeout')
        for key, _ in events:
            try:
                raw = os.read(key.fd, min(4096, 8193-self.counts[key.data]))
            except BlockingIOError:
                continue
            if not raw:
                self.selector.unregister(key.fileobj)
                continue
            self.counts[key.data] += len(raw)
            need(self.counts[key.data] <= 8192, 'identity_output_too_large')
            if key.data == 'out':
                self.output += raw
            # stderr is counted but never stored or returned, including on failure.

    def line(self):
        while b'\n' not in self.output:
            need(any(k.data == 'out' for k in self.selector.get_map().values()), 'database_probe_failed')
            self.pump()
        line, self.output = self.output.split(b'\n', 1)
        need(len(line) <= 4096, 'identity_output_too_large')
        return line

    def finish(self):
        self.send(END)
        self.child.stdin.close()
        need(self.line() == ACK, 'invalid_identity_acknowledgement')
        while self.selector.get_map():
            self.pump()
        need(not self.output, 'unexpected_identity_output')
        need(self.child.wait(timeout=remaining(self.deadline)) == 0, 'database_probe_failed')

    def __exit__(self, *_):
        self.selector.close()
        # Only the directly created psql process is signalled. Static input and
        # -X cannot run shell commands; do not signal a system service or group.
        try:
            if self.child.poll() is None:
                self.child.kill()
            self.child.wait(timeout=1)
        finally:
            for stream in (self.child.stdin, self.child.stdout, self.child.stderr):
                stream.close()


def validate_row(raw, source, port):
    need(isinstance(raw, bytes) and 0 < len(raw) <= 4096, 'invalid_identity_response')
    value = PREFLIGHT.object_json(raw)
    need(set(value) == FIELDS and type(value['format']) is int and value['format'] == 1,
         'invalid_identity_response')
    need(type(value['backend_pid']) is int and 0 < value['backend_pid'] <= 2147483647
         and type(value['database_port']) is int and value['database_port'] == port,
         'database_response_binding_mismatch')
    need(value['source_id'] == source and value['source_exists'] is True, 'identity_source_unavailable')
    need(value['database_name'] == value['database_user'] == value['database_session_user'] == 'ultrabrain'
         and value['unix_socket'] is True and value['read_only'] is True,
         'database_response_binding_mismatch')
    need(value['schema_ready'] is True, 'identity_schema_unavailable')
    need(isinstance(value['instance_id'], str) and UUID.fullmatch(value['instance_id'])
         and value['instance_id'] != '00000000-0000-0000-0000-000000000000', 'invalid_instance_identity')
    return value


def socket_snapshot(directory, port):
    value = os.stat('.s.PGSQL.'+str(port), dir_fd=directory, follow_symlinks=False)
    need(stat.S_ISSOCK(value.st_mode) and value.st_uid == os.geteuid() and value.st_nlink == 1,
         'unsafe_database_socket')
    return FS.metadata(value)


def observe(home, source='default', *, root=ROOT, deadline=None):
    platform_check()
    deadline = observation_deadline(deadline)
    home = selection(home, source)
    root = FS.absolute(root)
    need(home != root and root not in home.parents and home not in root.parents, 'home_overlaps_repository')
    pins = PREFLIGHT.check_pins(root)
    with PREFLIGHT.PrivateHome(home) as view:
        need(not view.missing, 'not_installed')
        database = PROCESS.database_snapshot(view, pins)
        state = PREFLIGHT.validate_state(PREFLIGHT.object_json(view.read('postgres/state.json')))
        prefix = 'runtime/'+database['runtime_directory']
        view.metadata(prefix+'/lib', private=False, directory=True)
        # Hold the original executable/installation and private socket directory
        # across authentication, SQL and backend inspection, rechecking at exit.
        with PROCESS._executable(home/prefix/'bin/psql', os.geteuid()):
            with view.open('postgres/socket', directory=True) as directory:
                socket_before = socket_snapshot(directory, database['port'])
                command, environment = invocation(home, database, source, state['app_password'])
                view.unchanged()
                with PsqlSession(command, environment, deadline) as client:
                    client.send(SQL)
                    row = validate_row(client.line(), source, database['port'])
                    backend = PROCESS.verify_backend(database, row['backend_pid'])
                    need(PROCESS.database_snapshot(view, pins) == database, 'database_changed_during_check')
                    need(PROCESS.verify_backend(database, row['backend_pid']) == backend,
                         'database_backend_changed_during_check')
                    view.unchanged()
                    need(socket_snapshot(directory, database['port']) == socket_before, 'database_socket_changed')
                    need(PREFLIGHT.check_pins(root) == pins, 'source_lock_changed')
                    client.finish()  # Only an acknowledged rollback and clean exit qualify.
                need(PROCESS.database_snapshot(view, pins) == database, 'database_changed_during_check')
                need(socket_snapshot(directory, database['port']) == socket_before, 'database_socket_changed')
        view.unchanged()
        need(PREFLIGHT.check_pins(root) == pins, 'source_lock_changed')
        remaining(deadline)
    return {'format': 1, 'ok': True, 'source_id': source, 'instance_id': row['instance_id'],
            'identity_verified': True, 'database_process_binding_verified': True,
            'transport': 'private-unix-socket', 'authentication': 'os-peer-and-scram-sha-256',
            'scope': 'logical identity of the selected live managed database; not console or client readiness',
            **NO_ACTIONS}


def main(argv=None):
    try:
        args = list(sys.argv[1:] if argv is None else argv)
        need(len(args) <= 4 and len(args) % 2 == 0, 'invalid_arguments')
        options = {}
        for flag, value in zip(args[::2], args[1::2]):
            need(flag in ('--home', '--source') and flag not in options, 'invalid_arguments')
            options[flag] = value
        platform_check()
        home = options.get('--home', os.environ.get('ULTRABRAIN_HOME'))
        if home is None:
            home = str(Path.home()/'.local/share/ultrabrain')
        result = observe(home, options.get('--source', 'default'))
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        known = isinstance(error, (IdentityError, PREFLIGHT.PreflightError, FS.DeployError))
        code = str(error) if known and re.fullmatch('[a-z][a-z_]{0,79}', str(error)) else 'identity_unverified'
        print(json.dumps({'format': 1, 'ok': False, 'error': code, 'identity_verified': False,
                          **NO_ACTIONS}, sort_keys=True))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
