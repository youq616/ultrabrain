"""Real private files/locks and loopback sockets; fixture manager and processes.

These do not replace the actual ordinary-user systemd/PostgreSQL CI acceptance.
"""
import copy
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
m = module('ready_tested', ROOT/'scripts/personal-ready.py')
d = module('ready_deployment_fixture', ROOT/'test/test_personal_deploy.py')
TOKEN = '0123456789abcdef'*4
INSTANCE = '00000000-0000-4000-8000-000000000001'
INVOCATION = '23'*16


def response(request, *, source='personal', pid=1234, port=55432, **updates):
    request_raw = m.canonical([1, request['nonce'], request['origin'], request['invocation_id'], request['issued_at']])
    value = dict(zip(m.RESPONSE_FIELDS, [1, hashlib.sha256(request_raw).hexdigest(), request['nonce'],
        request['origin'], source, request['invocation_id'], pid, INSTANCE, 1235, port,
        'ultrabrain', 'ultrabrain', '127.0.0.1', 'ultrabrain', 1799999900]))
    value.update(updates)
    value['proof'] = hmac.new(bytes.fromhex(TOKEN), m.RESPONSE_DOMAIN + m.canonical(
        [value[key] for key in m.RESPONSE_FIELDS]), hashlib.sha256).hexdigest()
    return {'ok': True, 'result': value}


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.request, self.digest = m.challenge(TOKEN, 'http://127.0.0.1:3132', INVOCATION,
                                               nonce='10'*32, issued_at=1800000000)
        self.value = response(self.request)

    def verify(self, value):
        return m.verify_response(m.canonical(value), token=TOKEN, request=self.request,
             request_sha256=self.digest, source='personal', pid=1234, instance=INSTANCE, database_port=55432)

    def test_fixed_independent_python_node_vectors(self):
        self.assertEqual(self.digest, '985fb4de8b70292ba86fd529b8af6a68786e2a5c03ea97a6994dde20ce9cb39f')
        self.assertEqual(self.request['proof'], 'f25940f0c217695b1c2846f001f312170df9926d5383d70f6a6650f4026e4af9')
        self.assertEqual(self.value['result']['proof'], '308f0cda6178591e05d502038c7bcd26254e8d6a92e7ee3fcf1c485e6a4de436')
        self.assertEqual(self.verify(self.value)['instance_id'], INSTANCE)

    def test_challenges_use_new_random_nonces_and_no_token(self):
        values = [m.challenge(TOKEN, self.request['origin'], INVOCATION)[0] for _ in range(16)]
        self.assertEqual(len({v['nonce'] for v in values}), 16)
        self.assertNotIn(TOKEN, json.dumps(values))

    def test_every_response_field_is_authenticated(self):
        for key in m.RESPONSE_FIELDS:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.value)
                val = changed['result'][key]
                changed['result'][key] = val+1 if type(val) is int else val+'a'
                with self.assertRaises(m.ReadyError):
                    self.verify(changed)

    def test_even_signed_wrong_expected_bindings_are_rejected(self):
        changes = ({'nonce': 'ab'*32}, {'request_sha256': 'cd'*32}, {'source_id': 'foreign'},
                   {'origin': 'http://127.0.0.1:3133'}, {'invocation_id': '34'*16}, {'pid': 4321},
                   {'instance_id': '00000000-0000-4000-8000-000000000002'}, {'database_port': 55433},
                   {'database_name': 'foreign'}, {'database_user': 'postgres'},
                   {'database_address': '127.0.0.2'}, {'database_session_user': 'postgres'})
        for change in changes:
            with self.subTest(change=change), self.assertRaises(m.ReadyError):
                self.verify(response(self.request, **change))

    def test_response_cannot_reflect_request_proof_or_other_domain(self):
        self.value['result']['proof'] = self.request['proof']
        with self.assertRaises(m.ReadyError):
            self.verify(self.value)
        vals = [self.value['result'][key] for key in m.RESPONSE_FIELDS]
        self.value['result']['proof'] = hmac.new(bytes.fromhex(TOKEN), m.REQUEST_DOMAIN+m.canonical(vals), hashlib.sha256).hexdigest()
        with self.assertRaises(m.ReadyError):
            self.verify(self.value)

    def test_protocol_types_and_exact_fields(self):
        for key, val in [('format', True), ('pid', 1.0), ('backend_pid', 2**53),
                         ('proof', None), ('nonce', 'é'), ('extra', 'ignored')]:
            changed = copy.deepcopy(self.value)
            changed['result'][key] = val
            with self.subTest(key=key), self.assertRaises(m.ReadyError):
                self.verify(changed)
        self.value['ok'] = 1
        with self.assertRaises(m.ReadyError):
            self.verify(self.value)

    def test_duplicate_json_keys_nonfinite_and_nonascii_rejected(self):
        for raw in (b'{"ok":false,"ok":true}', b'{"ok":NaN}', b'{"ok":Infinity}', b'[]', b'{"x":"\xff"}'):
            with self.subTest(raw=raw), self.assertRaises(m.ReadyError):
                m.object_json(raw)


def http(body=b'{}', status=b'200 OK', extra=b'', length=None):
    return (b'HTTP/1.1 '+status+b'\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: '
            +str(len(body) if length is None else length).encode()+b'\r\n'+extra+b'\r\n'+body)


class WireTests(unittest.TestCase):
    def listen(self, handler):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(('127.0.0.1', 0)); listener.listen(1); listener.settimeout(2)
        port = listener.getsockname()[1]
        self.received = bytearray()
        failures = []
        def serve():
            try:
                with listener:
                    conn, _ = listener.accept()
                    with conn:
                        conn.settimeout(2)
                        while True:
                            self.received.extend(conn.recv(4096))
                            header, sep, body = self.received.partition(b'\r\n\r\n')
                            if sep:
                                length = int(header.split(b'Content-Length: ')[1].split(b'\r\n')[0])
                                if len(body) == length:
                                    break
                        handler(conn)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                failures.append(error)
        thread = threading.Thread(target=serve, daemon=True); thread.start()
        def finish():
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertFalse(failures, failures)
        self.addCleanup(finish)
        return port

    def test_foreign_listener_receives_only_limited_readiness_proof(self):
        port = self.listen(lambda conn: conn.sendall(http(status=b'401 Unauthorized')))
        req, _ = m.challenge(TOKEN, 'http://127.0.0.1:'+str(port), INVOCATION)
        with patch.dict(os.environ, {'HTTP_PROXY': 'http://never.invalid', 'ALL_PROXY': 'http://never.invalid'}):
            with self.assertRaisesRegex(m.ReadyError, 'readiness_unverified'):
                m.probe_http(port, m.canonical(req), deadline=time.monotonic()+2)
        self.assertIn(b'POST /api/readiness HTTP/1.1', self.received)
        self.assertNotIn(TOKEN.encode(), self.received)
        self.assertNotIn(b'Bearer', self.received)
        self.assertNotIn(b'Authorization', self.received)

    def test_successful_response_with_split_packets(self):
        def send(conn):
            wire = http(b'{"ok":true}')
            for chunk in (wire[:7], wire[7:47], wire[47:]):
                conn.sendall(chunk)
        port = self.listen(send)
        self.assertEqual(m.probe_http(port, b'{}', deadline=time.monotonic()+2), b'{"ok":true}')

    def test_complete_length_delimited_response_does_not_wait_for_peer_close(self):
        release = threading.Event()
        def hold(conn):
            conn.sendall(http(b'{"ok":true}'))
            release.wait(2)
        port = self.listen(hold)
        try:
            self.assertEqual(m.probe_http(port, b'{}', deadline=time.monotonic()+.25), b'{"ok":true}')
        finally:
            release.set()

    def test_redirect_is_rejected_and_not_followed(self):
        port = self.listen(lambda conn: conn.sendall(http(status=b'302 Found', extra=b'Location: http://secret.invalid/\r\n')))
        with self.assertRaisesRegex(m.ReadyError, 'readiness_unverified'):
            m.probe_http(port, b'{}', deadline=time.monotonic()+2)

    def test_oversized_response_is_bounded(self):
        port = self.listen(lambda conn: conn.sendall(b'x'*9000))
        # Incremental parsing may reject the malformed/oversized header before
        # the overall response byte budget is reached; both are bounded refusals.
        with self.assertRaisesRegex(m.ReadyError, 'readiness_response_too_large|invalid_readiness_http'):
            m.probe_http(port, b'{}', deadline=time.monotonic()+2)

    def test_drip_response_cannot_extend_total_deadline(self):
        def drip(conn):
            for _ in range(30):
                conn.sendall(b'x'); time.sleep(.025)
        port = self.listen(drip)
        start = time.monotonic()
        with self.assertRaisesRegex(m.ReadyError, 'readiness_timeout'):
            m.probe_http(port, b'{}', deadline=start+.12)
        self.assertLess(time.monotonic()-start, .6)

    def test_ambiguous_http_framing_rejected(self):
        for raw in (http(extra=b'Content-Length: 2\r\n'), http(extra=b'Transfer-Encoding: chunked\r\n'),
                    http(extra=b'Content-Encoding: gzip\r\n'), http(length=1), http(length=3),
                    http(extra=b' folded: value\r\n'), b'HTTP/1.1 200 OK\n\n{}',
                    http(extra=b'X-A: \x00\r\n'), http(extra=b'X-A: '+b'a'*4096+b'\r\n')):
            with self.subTest(raw=raw[:100]), self.assertRaises(m.ReadyError):
                m.parse_http(raw)

    def test_maximum_header_accepts_each_split_delimiter_prefix(self):
        prefix = http(extra=b'X-Pad: \r\n').partition(b'\r\n\r\n')[0]
        header = prefix + b'x'*(4096-len(prefix))
        self.assertEqual(len(header), 4096)
        for size in range(4):
            with self.subTest(size=size):
                self.assertIsNone(m.parse_http(header+b'\r\n\r\n'[:size], partial=True))
        self.assertEqual(m.parse_http(header+b'\r\n\r\n{}'), b'{}')


class ReadyFixtureManager:
    def __init__(self, fixture):
        self.fixture = fixture
        self.unit_paths = (fixture.units,)
        self.invocation = INVOCATION
        self.pid = '1234'
        self.calls = 0
    def __call__(self, action):
        if action != 'show':
            raise AssertionError('Readiness must never mutate manager')
        self.calls += 1
        rows = self.fixture('show')
        self.console = {**rows[m.SERVICES.CONSOLE], 'MainPID': self.pid,
                        'InvocationID': self.invocation, 'ControlGroup': '/fixture.service'}
        return rows


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.manager = m.LocalManager(); self.manager.deadline = time.monotonic()+10
        self.rows = {n: d.FixtureManager.absent(n) for n in m.DEPLOY.PERSONAL_UNITS}
        self.rows[m.SERVICES.CONSOLE].update(LoadState='loaded', ActiveState='active', SubState='running',
                                             FragmentPath='/fixture/console')
        self.detail = {**self.rows[m.SERVICES.CONSOLE], 'MainPID': '1234',
                       'InvocationID': INVOCATION, 'ControlGroup': '/fixture.service'}
    def run_fixture(self, _args, **kwargs):
        self.assertGreater(kwargs['timeout'], 0); self.assertLessEqual(kwargs['timeout'], 5)
        if 'UnitPath' in _args[1]:
            return 0, b'UnitPath=/fixture/units\n'
        values = [self.detail] if 'MainPID' in _args[1] else self.rows.values()
        return 0, ('\n\n'.join('\n'.join(k+'='+v for k, v in row.items()) for row in values)+'\n').encode()
    def test_only_fixed_read_only_queries_and_bounded_deadlines(self):
        with patch.object(m.DEPLOY, 'run_manager', side_effect=self.run_fixture) as call:
            self.assertEqual(self.manager('show'), self.rows)
            for entry in call.call_args_list:
                args = entry.args[0]
                self.assertIn('show', args)
                self.assertFalse(set(args)&{'start', 'stop', 'reload', 'daemon-reload', 'enable', 'disable'})
            self.assertEqual(call.call_count, 3)
    def test_mutation_action_or_elapsed_deadline_never_executes(self):
        with patch.object(m.DEPLOY, 'run_manager') as call:
            with self.assertRaises(m.ReadyError): self.manager('reload')
            self.manager.deadline = time.monotonic()-1
            with self.assertRaises(m.ReadyError): self.manager('show')
            call.assert_not_called()
    def test_manager_changed_between_base_and_process_queries_is_refused(self):
        self.detail['ActiveState'] = 'inactive'
        with patch.object(m.DEPLOY, 'run_manager', side_effect=self.run_fixture):
            with self.assertRaisesRegex(m.ReadyError, 'console_changed_during_check'): self.manager('show')
    def test_duplicate_missing_and_unexpected_manager_properties_rejected(self):
        for text in ('Id=a\nId=b', 'Id=a', 'Id=a\nUnexpected=value'):
            with self.subTest(text=text), self.assertRaises(m.ReadyError):
                self.manager._row(text, m.DETAIL)


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ub-ready-fixture-'); self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name); self.home = self.base/'data'; self.account = self.base/'account'
        self.home.mkdir(mode=0o700); self.account.mkdir(mode=0o700)
        self.units = self.account/'.config/systemd/user'; self.units.mkdir(parents=True, mode=0o700)
        self.fixture = d.FixtureManager(self.units)
        self.deployer = m.DEPLOY.Context(self.home, user_home=self.account, manager=self.fixture)
        self.plan = m.SERVICES.plan(ROOT, self.home, '/usr/bin/bun', source='personal')
        export = self.base/'export'; m.SERVICES.export_plan(self.plan, export, self.plan['plan_sha256'])
        planned = self.deployer.plan(self.plan, export, self.plan['plan_sha256'])
        result = self.deployer.apply(self.plan, export, self.plan['plan_sha256'], planned['deployment_sha256'])
        self.current = result['current_sha256']
        self.fixture.overrides[m.SERVICES.CONSOLE] = {'ActiveState': 'active', 'SubState': 'running'}
        self.manager = ReadyFixtureManager(self.fixture)
        self.token_file = self.home/'personal-console-token'; self.token_file.write_text(TOKEN+'\n'); self.token_file.chmod(0o600)
        self.database = {'port': 55432, 'postmaster': {'pid': 1000, 'start_ticks': 123}}
        self.backend = {'pid': 1235, 'ppid': 1000, 'start_ticks': 124}
        self.process = {'pid': 1234, 'start_ticks': 125}
        self.processes = SimpleNamespace(console_snapshot=lambda *_a, **_k: copy.deepcopy(self.process),
            database_snapshot=lambda *_a, **_k: copy.deepcopy(self.database),
            verify_backend=lambda *_a, **_k: copy.deepcopy(self.backend))
        self.context = m.Context(self.home, user_home=self.account, manager=self.manager,
                                 processes=self.processes, transport=self.transport)
        self.calls = 0; self.after_probe = lambda: None
    def transport(self, _port, body, **_kw):
        self.calls += 1
        req = json.loads(body)
        answer = m.canonical(response(req))
        self.after_probe()
        return answer
    def check(self, **updates):
        args = dict(bun='/usr/bin/bun', source='personal', port=3132,
                    expected_current=self.current, expected_instance=INSTANCE)
        args.update(updates)
        return self.context.check(**args)
    def test_success_is_read_only_and_returns_limited_verified_scope(self):
        before = d.tree_snapshot(self.base); actions = list(self.fixture.actions)
        result = self.check()
        self.assertTrue(result['application_ready']); self.assertTrue(result['database_process_binding_verified'])
        self.assertFalse(result['socket_owner_verified']); self.assertEqual(result['worker_readiness'], 'not_checked')
        self.assertEqual(d.tree_snapshot(self.base), before)
        self.assertTrue(all(action == 'show' for action in self.fixture.actions[len(actions):]))
        self.assertEqual(self.calls, 1)
    def test_wrong_receipt_plan_or_instance_cannot_pass(self):
        for updates in ({'expected_current': 'f'*64}, {'source': 'foreign'}, {'port': 3133},
                        {'bun': '/bin/foreign'}, {'expected_instance': INSTANCE[:-1]+'2'}):
            with self.subTest(updates=updates), self.assertRaises(m.ReadyError):
                self.check(**updates)
    def test_bad_manager_states_and_overrides_refused_before_network(self):
        saved = copy.deepcopy(self.fixture.overrides)
        for updates in ({'Names': m.SERVICES.CONSOLE+' alias.service'}, {'NeedDaemonReload': 'yes'},
                        {'DropInPaths': '/tmp/foreign.conf'}, {'Job': '7'}, {'FragmentPath': '/tmp/foreign'},
                        {'ActiveState': 'inactive'}, {'SubState': 'auto-restart'}):
            self.fixture.overrides = copy.deepcopy(saved)
            self.fixture.overrides[m.SERVICES.CONSOLE].update(updates)
            with self.subTest(updates=updates), self.assertRaises(m.ReadyError):
                self.check()
        self.assertEqual(self.calls, 0)
    def test_unexpected_worker_and_dependency_directory_refused(self):
        (self.units/(m.SERVICES.CONSOLE+'.upholds')).mkdir(mode=0o700)
        with self.assertRaises(m.ReadyError): self.check()
        self.assertEqual(self.calls, 0)
    def test_token_permissions_and_links_refused_before_network(self):
        self.token_file.chmod(0o644)
        with self.assertRaises(m.PREFLIGHT.PreflightError): self.check()
        self.token_file.chmod(0o600)
        other = self.home/'other-token'; self.token_file.rename(other); self.token_file.symlink_to(other)
        with self.assertRaises(OSError): self.check()
        self.assertEqual(self.calls, 0)
    def test_changed_invocation_process_or_database_during_probe_refused(self):
        for change in (lambda: setattr(self.manager, 'invocation', '45'*16),
                       lambda: self.process.update(start_ticks=555),
                       lambda: self.database['postmaster'].update(start_ticks=556)):
            self.after_probe = change
            with self.assertRaises(m.ReadyError): self.check()
            self.manager.invocation = INVOCATION; self.process['start_ticks'] = 125
            self.database['postmaster']['start_ticks'] = 123
    def test_rotated_token_or_replaced_link_during_probe_refused(self):
        self.after_probe = lambda: self.token_file.write_text('a'*64+'\n')
        with self.assertRaises(m.PREFLIGHT.PreflightError): self.check()
        self.token_file.write_text(TOKEN+'\n')
        link = self.units/m.SERVICES.CONSOLE
        target = os.readlink(link)
        def replace():
            staged = self.units/'replacement'; staged.symlink_to(target); os.replace(staged, link)
        self.after_probe = replace
        with self.assertRaises(m.ReadyError): self.check()
    def test_shared_pending_from_other_home_blocks_probe(self):
        value = {'home': str(self.base/'other'), 'user_home': str(self.account)}
        path = self.context.shared/'pending.json'; path.write_bytes(m.FS.canonical(value)); path.chmod(0o600)
        with self.assertRaisesRegex(m.ReadyError, 'other_deployment_pending'): self.check()
        self.assertEqual(self.calls, 0)
    def test_shared_lock_excludes_deployers_during_http_probe(self):
        outcomes = []
        def competing():
            with self.assertRaisesRegex(m.ReadyError, 'deployment_busy'):
                with m.DEPLOY.Context(self.home, user_home=self.account)._lock(write=True):
                    self.fail('exclusive deployment lock acquired during probe')
            outcomes.append(True)
        self.after_probe = competing
        self.check(); self.assertEqual(outcomes, [True])
    def test_existing_exclusive_lock_blocks_probe_without_network(self):
        with open(self.context.shared/'lock', 'rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(m.ReadyError, 'deployment_busy'): self.check()
        self.assertEqual(self.calls, 0)


if __name__ == '__main__':
    unittest.main()
