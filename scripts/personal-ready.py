#!/usr/bin/env python3
"""Authenticate the current personal console and its live managed database.

Read-only, ordinary Linux service account only. The shared deployment lock is
held throughout the observation. A short-lived HMAC challenge never transmits
the console bearer token. This is an observation, not an activation operation,
source-code attestation, socket-owner certificate or future health guarantee.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import argparse
import errno
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import selectors
import socket
import time


def sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DEPLOY = sibling('ready_deploy', 'personal-deploy.py')
PREFLIGHT = sibling('ready_preflight', 'preflight.py')
PROCESS = sibling('ready_process', 'personal_ready_process.py')
FS, SERVICES = DEPLOY.FS, DEPLOY.SERVICES
ReadyError, need = FS.DeployError, FS.need
ROOT = Path(__file__).resolve().parents[1]
DETAIL = (*DEPLOY.PROPERTIES, 'MainPID', 'InvocationID', 'ControlGroup')
REQUEST_DOMAIN = b'ultrabrain-personal-ready-request-v1\n'
RESPONSE_DOMAIN = b'ultrabrain-personal-ready-response-v1\n'
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
RESPONSE_FIELDS = ('format', 'request_sha256', 'nonce', 'origin', 'source_id',
                   'invocation_id', 'pid', 'instance_id', 'backend_pid',
                   'database_port', 'database_name', 'database_user',
                   'database_address', 'database_session_user', 'postmaster_started')
NO_ACTIONS = {'configuration_changed': False, 'services_started': False,
              'services_stopped': False, 'enablement_changed': False, 'model_called': False}


def remaining(deadline):
    value = deadline - time.monotonic()
    need(value > 0, 'readiness_timeout')
    return value


def canonical(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def object_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            need(key not in value, 'invalid_readiness_response')
            value[key] = item
        return value
    def invalid(_):
        raise ReadyError('invalid_readiness_response')
    try:
        value = json.loads(raw.decode('ascii'), object_pairs_hook=pairs, parse_constant=invalid)
    except (UnicodeError, ValueError, RecursionError):
        raise ReadyError('invalid_readiness_response') from None
    need(isinstance(value, dict), 'invalid_readiness_response')
    return value


def challenge(token, origin, invocation, *, nonce=None, issued_at=None):
    # Optional values are internal protocol-vector seams, never CLI/env switches.
    nonce = nonce if nonce is not None else secrets.token_hex(32)
    issued_at = issued_at if issued_at is not None else int(time.time())
    value = {'format': 1, 'nonce': nonce, 'origin': origin,
             'invocation_id': invocation, 'issued_at': issued_at}
    raw = canonical(list(value.values()))
    value['proof'] = hmac.new(bytes.fromhex(token), REQUEST_DOMAIN + raw, hashlib.sha256).hexdigest()
    return value, hashlib.sha256(raw).hexdigest()


def verify_response(raw, *, token, request, request_sha256, source, pid, instance, database_port):
    envelope = object_json(raw)
    need(set(envelope) == {'ok', 'result'} and envelope['ok'] is True,
         'readiness_unverified')
    value = envelope['result']
    need(isinstance(value, dict) and set(value) == {*RESPONSE_FIELDS, 'proof'},
         'invalid_readiness_response')
    for key in ('format', 'pid', 'backend_pid', 'database_port', 'postmaster_started'):
        need(type(value[key]) is int and 0 < value[key] <= 2**53 - 1,
             'invalid_readiness_response')
    for key in set(RESPONSE_FIELDS) - {'format', 'pid', 'backend_pid', 'database_port', 'postmaster_started'}:
        need(isinstance(value[key], str) and value[key].isascii() and len(value[key]) <= 128,
             'invalid_readiness_response')
    need(value['format'] == 1 and isinstance(value['proof'], str)
         and re.fullmatch('[a-f0-9]{64}', value['proof'])
         and re.fullmatch('[a-f0-9]{64}', value['request_sha256'])
         and re.fullmatch('[a-f0-9]{64}', value['nonce'])
         and re.fullmatch('[a-f0-9]{32}', value['invocation_id'])
         and UUID.fullmatch(value['instance_id']) is not None
         and value['instance_id'] != '00000000-0000-0000-0000-000000000000'
         and 1024 <= value['database_port'] <= 65535,
         'invalid_readiness_response')
    proof = hmac.new(bytes.fromhex(token), RESPONSE_DOMAIN + canonical(
        [value[key] for key in RESPONSE_FIELDS]), hashlib.sha256).hexdigest()
    need(hmac.compare_digest(proof, value['proof']), 'readiness_unverified')
    need(value['request_sha256'] == request_sha256 and value['nonce'] == request['nonce']
         and value['origin'] == request['origin'] and value['invocation_id'] == request['invocation_id']
         and value['source_id'] == source and value['pid'] == pid,
         'console_response_binding_mismatch')
    need(value['instance_id'] == instance, 'expected_instance_mismatch')
    need(value['database_port'] == database_port and value['database_address'] == '127.0.0.1'
         and value['database_name'] == value['database_user'] == value['database_session_user'] == 'ultrabrain',
         'database_response_binding_mismatch')
    return value


def parse_http(raw):
    # Only our bounded, length-delimited HTTP endpoint is supported. No proxies,
    # redirects, trailers, compression, transfer encodings or alternate routes.
    header, separator, body = raw.partition(b'\r\n\r\n')
    need(separator and len(header) <= 4096, 'invalid_readiness_http')
    lines = header.split(b'\r\n')
    need(re.fullmatch(rb'HTTP/1\.[01] [0-9]{3}(?: [\x20-\x7e]*)?', lines[0]),
         'invalid_readiness_http')
    fields = {}
    for line in lines[1:]:
        key, delimiter, val = line.partition(b':')
        need(delimiter and re.fullmatch(rb'[A-Za-z0-9-]+', key)
             and all(32 <= c <= 126 for c in val), 'invalid_readiness_http')
        key = key.lower()
        need(key not in fields, 'invalid_readiness_http')
        fields[key] = val.strip()
    need(b'transfer-encoding' not in fields and b'content-encoding' not in fields,
         'invalid_readiness_http')
    length = fields.get(b'content-length', b'')
    need(re.fullmatch(rb'(?:0|[1-9][0-9]{0,3})', length) and int(length) == len(body)
         and len(body) <= 4096, 'invalid_readiness_http')
    need(lines[0].split(b' ', 2)[1] == b'200', 'readiness_unverified')
    need(fields.get(b'content-type', b'').lower() == b'application/json; charset=utf-8',
         'invalid_readiness_http')
    return body


def probe_http(port, body, *, deadline):
    need(type(port) is int and 1024 <= port <= 65535 and len(body) <= 1024, 'invalid_probe')
    host = '127.0.0.1:' + str(port)
    request = ('POST /api/readiness HTTP/1.1\r\nHost: ' + host + '\r\nOrigin: http://' + host
               + '\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: '
               + str(len(body)) + '\r\n\r\n').encode('ascii') + body
    deadline = min(deadline, time.monotonic() + 4)
    chunks, total = [], 0
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.setblocking(False)
        result = client.connect_ex(('127.0.0.1', port))
        need(result in (0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY), 'console_unreachable')
        with selectors.DefaultSelector() as selector:
            selector.register(client, selectors.EVENT_WRITE)
            need(selector.select(remaining(deadline)), 'readiness_timeout')
            need(client.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0, 'console_unreachable')
            sent = 0
            while sent < len(request):
                need(selector.select(remaining(deadline)), 'readiness_timeout')
                try:
                    count = client.send(request[sent:])
                except BlockingIOError:
                    continue
                need(count > 0, 'console_unreachable')
                sent += count
            selector.modify(client, selectors.EVENT_READ)
            while True:
                need(selector.select(remaining(deadline)), 'readiness_timeout')
                try:
                    chunk = client.recv(min(4096, 8193-total))
                except BlockingIOError:
                    continue
                if not chunk:
                    break
                total += len(chunk)
                need(total <= 8192, 'readiness_response_too_large')
                chunks.append(chunk)
    return parse_http(b''.join(chunks))


class LocalManager(DEPLOY.LocalManager):
    """A fixed read-only property inventory; no manager action can be dispatched."""
    def __init__(self):
        super().__init__()
        self.deadline = None
        self.console = None

    def _run(self, args):
        timeout = min(5, remaining(self.deadline))
        return DEPLOY.run_manager(args, timeout=timeout)

    def __call__(self, action):
        need(action == 'show', 'read_only_manager_required')
        code, raw = self._run(['--all', '--property=UnitPath', 'show'])
        text = DEPLOY.manager_text(raw)
        need(code == 0 and text.startswith('UnitPath=') and text.count('\n') == 1,
             'manager_unit_paths_unavailable')
        paths = text.rstrip('\n').partition('=')[2].split(' ')
        need(paths and all(p and '\\' not in p for p in paths), 'unsupported_manager_unit_paths')
        self.unit_paths = tuple(FS.absolute(p) for p in paths)
        code, raw = self._run(['--all', '--property='+','.join(DEPLOY.PROPERTIES), 'show', '--',
                               *DEPLOY.PERSONAL_UNITS])
        rows = {}
        for block in re.split(r'\n\n+', DEPLOY.manager_text(raw).strip('\n')):
            row = self._row(block, DEPLOY.PROPERTIES)
            need(row['Id'] in DEPLOY.PERSONAL_UNITS and row['Id'] not in rows, 'invalid_manager_response')
            rows[row['Id']] = row
        need(set(rows) == set(DEPLOY.PERSONAL_UNITS) and (code == 0 or code == 5 and
             any(row['LoadState'] == 'not-found' for row in rows.values())), 'manager_unavailable')
        code, raw = self._run(['--all', '--property='+','.join(DETAIL), 'show', '--', SERVICES.CONSOLE])
        need(code == 0, 'manager_unavailable')
        self.console = self._row(DEPLOY.manager_text(raw).strip('\n'), DETAIL)
        need({key: self.console[key] for key in DEPLOY.PROPERTIES} == rows[SERVICES.CONSOLE],
             'console_changed_during_check')
        return rows

    @staticmethod
    def _row(text, properties):
        value = {}
        for line in text.split('\n'):
            key, delimiter, val = line.partition('=')
            need(delimiter and key in properties and key not in value, 'invalid_manager_response')
            value[key] = val
        need(set(value) == set(properties), 'invalid_manager_response')
        return value


class Context(DEPLOY.Context):
    def __init__(self, home, *, user_home=None, manager=None, processes=None, transport=None, root=None):
        super().__init__(home, user_home=user_home, manager=manager or LocalManager())
        self.processes = processes or PROCESS
        self.transport = transport or probe_http
        self.root = FS.absolute(root or ROOT)

    def _snapshot(self, plan, expected, *, bun, source, port, deadline):
        remaining(deadline)
        self._lock_check()
        need(self.lock_identity is not None, 'deployment_lock_missing')
        need(self._pending() is None, 'deployment_pending')
        current, identity = self._current()
        need(current == expected, 'current_deployment_mismatch')
        receipt = self._receipt(current)
        need(receipt is not None and receipt['plan'] == plan, 'installed_plan_mismatch')
        links, targets = self._links(), self._targets(receipt)
        need(all((links[name]['target'] if links[name] else None) == targets[name]
                 for name in DEPLOY.PERSONAL_UNITS), 'installed_units_changed')
        generation = self.state/'generations'/plan['plan_sha256']
        generation_files = {name: self.store.read(generation/name)[1]
                            for name in (*plan['units'], 'manifest.json')}
        self.manager.deadline = deadline
        rows = self.manager('show')
        self._check_paths()
        need(set(rows) == set(DEPLOY.PERSONAL_UNITS), 'invalid_manager_response')
        for name in DEPLOY.PERSONAL_UNITS:
            row = rows[name]
            need(set(row) == set(DEPLOY.PROPERTIES) and row['Id'] == row['Names'] == name
                 and row['DropInPaths'] == '' and row['NeedDaemonReload'] == 'no'
                 and row['Job'] in ('', '0'), 'unit_manager_binding_mismatch')
            if targets[name] is None:
                need(row['LoadState'] == 'not-found' and row['FragmentPath'] == ''
                     and row['ActiveState'] == 'inactive', 'unexpected_personal_unit')
            else:
                need(row['LoadState'] == 'loaded' and row['FragmentPath'] in
                     (targets[name], str(self.unit_dir/name)), 'unit_manager_binding_mismatch')
        console = self.manager.console
        need(isinstance(console, dict) and set(console) == set(DETAIL)
             and {k: console[k] for k in DEPLOY.PROPERTIES} == rows[SERVICES.CONSOLE]
             and console['ActiveState'] == 'active' and console['SubState'] == 'running',
             'console_not_running')
        process = self.processes.console_snapshot(console, root=self.root, bun=bun,
                                                  source=source, port=port, uid=self.uid)
        remaining(deadline)
        return {'current': current, 'current_identity': identity, 'links': links,
                'directories': {**self._directories(), 'shared': self._directory_id(self.shared)},
                'generation_identity': self._directory_id(generation), 'generation_files': generation_files,
                'unit_paths': [str(p) for p in self.manager.unit_paths],
                'units': rows, 'console': console, 'process': process}

    def check(self, *, bun, source, port, expected_current, expected_instance):
        deadline = time.monotonic() + 10
        bun = FS.absolute(bun)
        FS.sha(expected_current)
        need(isinstance(expected_instance, str) and UUID.fullmatch(expected_instance)
             and expected_instance != '00000000-0000-0000-0000-000000000000', 'invalid_expected_instance')
        plan = SERVICES.plan(str(self.root), str(self.home), str(bun), source=source, port=port)
        with self._lock(), PREFLIGHT.PrivateHome(self.home) as view:
            before = self._snapshot(plan, expected_current, bun=bun, source=source, port=port, deadline=deadline)
            pins = PREFLIGHT.check_pins(self.root)
            database = self.processes.database_snapshot(view, pins)
            token = view.read('personal-console-token', limit=128).strip().decode('ascii')
            need(re.fullmatch('[a-f0-9]{64}', token), 'invalid_console_token')
            origin = 'http://127.0.0.1:' + str(port)
            request, digest = challenge(token, origin, before['console']['InvocationID'])
            raw = self.transport(port, canonical(request), deadline=deadline)
            result = verify_response(raw, token=token, request=request, request_sha256=digest,
                                     source=source, pid=int(before['console']['MainPID']),
                                     instance=expected_instance, database_port=database['port'])
            backend = self.processes.verify_backend(database, result['backend_pid'], uid=self.uid)
            view.unchanged()
            need(self.processes.database_snapshot(view, pins) == database, 'database_changed_during_check')
            after = self._snapshot(plan, expected_current, bun=bun, source=source, port=port, deadline=deadline)
            need(after == before, 'installation_changed_during_check')
            need(self.processes.verify_backend(database, result['backend_pid'], uid=self.uid) == backend,
                 'database_backend_changed_during_check')
            need(PREFLIGHT.check_pins(self.root) == pins, 'source_lock_changed')
            view.unchanged()
            self._lock_check()
            remaining(deadline)
            return {'format': 1, 'application_ready': True, 'current_sha256': expected_current,
                    'source_id': source, 'instance_id': result['instance_id'],
                    'console_pid': result['pid'], 'invocation_id': result['invocation_id'],
                    'unit_binding_verified': True, 'database_process_binding_verified': True,
                    'expected_instance_verified': True, 'authenticated_console_ready': True,
                    'worker_readiness': 'not_checked', 'socket_owner_verified': False,
                    'scope': 'current console/source and live managed database; not future availability or model quality',
                    **NO_ACTIONS}


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise ReadyError('invalid_arguments')


def main(argv=None):
    try:
        argv = list(sys.argv[1:] if argv is None else argv)
        parser = Parser(description=__doc__, allow_abbrev=False)
        parser.add_argument('--home', default=os.environ.get('ULTRABRAIN_HOME',
                            str(Path(pwd.getpwuid(os.geteuid()).pw_dir)/'.local/share/ultrabrain')))
        parser.add_argument('--bun', required=True)
        parser.add_argument('--source', default='default')
        parser.add_argument('--port', type=int, default=3132)
        parser.add_argument('--expected-current', required=True)
        parser.add_argument('--expected-instance', required=True)
        flags = [a.partition('=')[0] for a in argv if a.startswith('--')]
        need(len(flags) == len(set(flags)), 'invalid_arguments')
        args = parser.parse_args(argv)
        need(sys.platform == 'linux' and os.getuid() == os.geteuid() != 0,
             'ordinary_linux_account_required')
        result = Context(args.home).check(bun=args.bun, source=args.source, port=args.port,
                                         expected_current=args.expected_current,
                                         expected_instance=args.expected_instance)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=True))
        return 0
    except Exception as error:
        known = isinstance(error, (ReadyError, PREFLIGHT.PreflightError, SERVICES.ServicePlanError,
                                   PROCESS.ReadyError))
        code = str(error) if known and re.fullmatch('[a-z][a-z_]{0,79}', str(error)) else 'personal_readiness_failed'
        print(json.dumps({'ok': False, 'error': code, 'application_ready': False, **NO_ACTIONS}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
