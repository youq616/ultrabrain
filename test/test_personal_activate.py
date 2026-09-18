"""Activation transactions on real private files, symlinks, locks and HMACs.

The manager and procfs observations are explicit fixtures. These tests do not
claim an ordinary-user systemd/PostgreSQL deployment or a real D-Bus fence.
"""
import contextlib
import copy
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


m = module('personal_activation_tested', ROOT/'scripts/personal-activate.py')
r = module('activation_readiness_fixture', ROOT/'test/test_personal_ready.py')
d = r.d
s = m.SERVICES
TOKEN, INSTANCE, INVOCATION = r.TOKEN, r.INSTANCE, r.INVOCATION


class PowerLoss(BaseException):
    """Interrupt after a durability boundary without exception compensation."""


class FixtureBus:
    def __init__(self, fixture):
        self.fixture = fixture
        self.identity = {'boot_id': 'a'*32, 'bus_id': 'b'*32,
                         'manager_owner': ':1.2', 'manager_pid': 567,
                         'manager_start_ticks': 123, 'uid': os.geteuid(),
                         'version': '255.4'}
        self.connections = set()
        self.sender_serial = 20
        self.starts = []
        self.events = []
        self.invocation = INVOCATION
        self.pid = '0'
        self.control_pid = 0
        self.contract = {'start': [s.CONSOLE], 'requires': [s.DATABASE],
                         'cached_command': 'fixture-approved-console'}
        self.database_runtime = {'ActiveState': 'active', 'SubState': 'exited',
                                 'MainPID': 0, 'Job': [0, '/']}
        self.before_show = lambda: None
        self.after_graph = lambda: None
        self.after_start = lambda: None
        self.fence_error = None
        self.offline = False

    def state(self, active='inactive', sub='dead', *, pid='0'):
        self.fixture.overrides[s.CONSOLE] = {'ActiveState': active, 'SubState': sub}
        self.pid = pid


class FixtureManager:
    """A connection lifetime around a shared fixture manager's runtime state."""
    def __init__(self, bus):
        self.bus = bus
        self.unit_paths = (bus.fixture.units,)
        self.deadline = None
        self.console = None
        self.closed = False
        self.connected = False
        self.close_hook = lambda: None
        bus.sender_serial += 1
        self.sender = ':1.'+str(bus.sender_serial)

    def _connect(self):
        if self.closed:
            raise AssertionError('a closed fixture connection was reused')
        if self.bus.offline:
            raise m.MANAGER.ActivateManagerError('manager_unavailable')
        self.connected = True
        self.bus.connections.add(self.sender)

    @property
    def sender_name(self):
        self._connect()
        return self.sender

    def __call__(self, action):
        if action != 'show':
            raise AssertionError('activation requested forbidden manager action '+action)
        self._connect()
        self.bus.before_show()
        rows = self.bus.fixture('show')
        self.console = {**rows[s.CONSOLE], 'MainPID': self.bus.pid,
                        'InvocationID': self.bus.invocation if self.bus.pid != '0' else '',
                        'ControlGroup': '/fixture.service' if self.bus.pid != '0' else ''}
        self.bus.events.append(('show', self.sender))
        return rows

    def connection_identity(self):
        self._connect()
        return copy.deepcopy(self.bus.identity)

    def verify_identity(self, expected):
        self._connect()
        self.bus.events.append(('verify_identity', self.sender))
        if self.bus.identity != expected:
            raise m.MANAGER.ActivateManagerError('manager_identity_changed')

    def inspect_graph(self, *, expect_console, **_args):
        self._connect()
        rows = self.bus.fixture('show')
        console = rows[s.CONSOLE]
        if expect_console == 'stopped':
            allowed = console['ActiveState'] == 'inactive' and console['SubState'] == 'dead'
        elif expect_console == 'terminal':
            allowed = console['ActiveState'] in ('inactive', 'failed') and console['SubState'] in ('dead', 'failed')
        else:
            allowed = console['ActiveState'] == 'active' and console['SubState'] == 'running'
        if expect_console in ('stopped', 'terminal'):
            allowed = allowed and self.bus.pid == '0' and self.bus.control_pid == 0 and console['Job'] in ('', '0')
        if not allowed:
            raise m.MANAGER.ActivateManagerError('console_state_unverified')
        observations = {name: dict(row) for name, row in rows.items()}
        observations[s.CONSOLE].update(MainPID=self.bus.pid, ControlPID=self.bus.control_pid,
                                       InvocationID=self.bus.invocation if self.bus.pid != '0' else '')
        observations[s.DATABASE] = copy.deepcopy(self.bus.database_runtime)
        result = {'contract': copy.deepcopy(self.bus.contract), 'observation': observations}
        self.bus.after_graph()
        return result

    def start_console(self):
        self._connect()
        self.bus.starts.append((s.CONSOLE, 'fail', self.sender))
        self.bus.events.append(('StartUnit', self.sender))
        self.bus.state('active', 'running', pid='1234')
        self.bus.after_start()
        return '/org/freedesktop/systemd1/job/42'

    def fence_sender(self, expected, sender):
        self._connect()
        self.bus.events.append(('fence_sender', sender))
        self.verify_identity(expected)
        if self.bus.fence_error:
            raise m.MANAGER.ActivateManagerError(self.bus.fence_error)
        if sender in self.bus.connections:
            raise m.MANAGER.ActivateManagerError('activation_sender_still_connected')

    def close(self):
        if self.closed:
            return
        self.close_hook()
        self.bus.events.append(('close', self.sender))
        self.bus.connections.discard(self.sender)
        self.closed = True


class ActivationTests(unittest.TestCase):
    def setUp(self):
        previous = os.umask(0o077)
        self.addCleanup(os.umask, previous)
        tmp = tempfile.TemporaryDirectory(prefix='ub-activate-fixture-')
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.home, self.account = self.base/'data', self.base/'account'
        self.home.mkdir(mode=0o700); self.account.mkdir(mode=0o700)
        self.units = self.account/'.config/systemd/user'
        self.units.mkdir(parents=True, mode=0o700)
        self.fixture = d.FixtureManager(self.units)
        self.deployer = m.DEPLOY.Context(self.home, user_home=self.account, manager=self.fixture)
        self.service_plan = s.plan(ROOT, self.home, '/usr/bin/bun', source='personal')
        self.export = self.base/'export'
        s.export_plan(self.service_plan, self.export, self.service_plan['plan_sha256'])
        deployment = self.deployer.plan(self.service_plan, self.export, self.service_plan['plan_sha256'])
        installed = self.deployer.apply(self.service_plan, self.export, self.service_plan['plan_sha256'],
                                        deployment['deployment_sha256'])
        self.current = installed['current_sha256']
        self.bus = FixtureBus(self.fixture)
        self.bus.state()
        self.token = self.home/'personal-console-token'
        self.token.write_text(TOKEN+'\n'); self.token.chmod(0o600)
        self.database = {'port': 55432, 'postmaster': {'pid': 1000, 'start_ticks': 123}}
        self.backend = {'pid': 1235, 'ppid': 1000, 'start_ticks': 124}
        self.process = {'pid': 1234, 'start_ticks': 125}
        self.processes = SimpleNamespace(
            database_snapshot=lambda *_a, **_k: copy.deepcopy(self.database),
            console_snapshot=lambda *_a, **_k: copy.deepcopy(self.process),
            verify_backend=lambda *_a, **_k: copy.deepcopy(self.backend))
        self.probes = 0
        self.after_probe = lambda: None
        self.response_updates = {}
        self.transport_error = None
        self.managers = []
        self.options = dict(bun='/usr/bin/bun', source='personal', port=3132,
                            expected_current=self.current, expected_instance=INSTANCE)
        self.shared = self.deployer.shared
        self.activation = self.home/'personal-activation'
        self.addCleanup(lambda: self.assertTrue(set(self.fixture.actions) <= {'show', 'reload'}))

    def transport(self, _port, body, **_kwargs):
        self.probes += 1
        if self.transport_error:
            raise m.READY.ReadyError(self.transport_error)
        request = json.loads(body)
        result = m.READY.canonical(r.response(request, **self.response_updates))
        self.after_probe()
        return result

    def context(self, *, fault=None):
        manager = FixtureManager(self.bus)
        self.managers.append(manager)
        return m.Context(self.home, user_home=self.account, manager=manager,
                         processes=self.processes, transport=self.transport, fault=fault)

    def plan(self, **updates):
        return self.context().plan(**{**self.options, **updates})

    def apply(self, *, expected_plan=None, fault=None):
        expected_plan = expected_plan or self.plan()['activation_plan_sha256']
        return self.context(fault=fault).apply(expected_plan=expected_plan, **self.options)

    def pending(self):
        return json.loads((self.shared/'pending.json').read_bytes())['operation_sha256']

    def operation(self, operation=None):
        return self.activation/'operations'/(operation or self.pending())

    def write_json(self, path, value):
        path.write_bytes(m.FS.canonical(value)); path.chmod(0o600)

    def interrupt(self, label):
        fired = []
        def stop(observed):
            if observed == label:
                fired.append(observed)
                raise PowerLoss(label)
        with self.assertRaises(PowerLoss):
            self.apply(fault=stop)
        self.assertEqual(fired, [label])
        self.assertTrue(all(manager.closed for manager in self.managers))
        return self.pending() if (self.shared/'pending.json').exists() else None

    def assert_recovery_refused(self, operation, *, pattern=None):
        before = d.tree_snapshot(self.base)
        starts = list(self.bus.starts)
        with self.assertRaises(Exception) as caught:
            self.context().recover(operation)
        if pattern:
            self.assertRegex(str(caught.exception), pattern)
        self.assertEqual(d.tree_snapshot(self.base), before)
        self.assertEqual(self.bus.starts, starts)
        self.assertEqual(self.pending(), operation)

    def test_plan_reads_installed_state_without_creating_activation_or_token(self):
        before = d.tree_snapshot(self.base)
        plan = self.plan()
        self.assertEqual(d.tree_snapshot(self.base), before)
        self.assertEqual(self.bus.starts, [])
        self.assertEqual(self.probes, 0)
        self.assertEqual(plan['starts'], [s.CONSOLE])
        self.assertFalse(plan['target_started'])
        self.assertFalse(plan['worker_authorized'])
        self.assertEqual(plan['activation_plan_sha256'], m.FS.digest(
            {k: v for k, v in plan.items() if k != 'activation_plan_sha256'}))
        self.assertNotIn(TOKEN, json.dumps(plan))

    def test_wrong_plan_digest_has_no_filesystem_or_service_effect(self):
        before = d.tree_snapshot(self.base)
        with self.assertRaisesRegex(m.ActivateError, 'activation_plan_mismatch'):
            self.apply(expected_plan='f'*64)
        self.assertEqual(d.tree_snapshot(self.base), before)
        self.assertFalse(self.activation.exists())
        self.assertEqual(self.bus.starts, [])

    def test_plan_digest_expires_when_existing_token_changes(self):
        plan = self.plan()
        self.token.write_text('a'*64+'\n')
        before = d.tree_snapshot(self.base)
        with self.assertRaisesRegex(m.ActivateError, 'activation_plan_mismatch'):
            self.apply(expected_plan=plan['activation_plan_sha256'])
        self.assertEqual(d.tree_snapshot(self.base), before)
        self.assertEqual(self.bus.starts, [])

    def test_missing_token_is_not_created_and_never_dispatches(self):
        self.token.unlink()
        before = d.tree_snapshot(self.base)
        with self.assertRaises(FileNotFoundError):
            self.plan()
        self.assertEqual(d.tree_snapshot(self.base), before)
        self.assertEqual(self.bus.starts, [])

    def test_installed_plan_must_match_source_port_bun_and_receipt(self):
        for updates in ({'source': 'foreign'}, {'port': 3133}, {'bun': '/bin/foreign'},
                        {'expected_current': 'f'*64}):
            with self.subTest(updates=updates), self.assertRaises(m.ActivateError):
                self.plan(**updates)
        self.assertEqual(self.probes, 0)
        self.assertEqual(self.bus.starts, [])

    def test_apply_sends_one_direct_console_start_and_authenticates_readiness(self):
        reloads = self.fixture.reloads
        result = self.apply()
        self.assertEqual([(n, mode) for n, mode, _ in self.bus.starts], [(s.CONSOLE, 'fail')])
        self.assertEqual(self.fixture.reloads, reloads)
        self.assertEqual(result['dispatch_state'], 'acknowledged')
        self.assertIs(result['application_ready'], True)
        self.assertEqual(result['readiness']['instance_id'], INSTANCE)
        self.assertEqual(result['readiness']['source_id'], 'personal')
        self.assertEqual(result['readiness']['invocation_id'], INVOCATION)
        self.assertEqual(self.probes, 1)
        self.assertFalse((self.shared/'pending.json').exists())
        self.assertFalse(result['services_stopped'])
        self.assertFalse(result['automatic_stop_authorized'])
        self.assertTrue(all(manager.closed for manager in self.managers))

    def test_shared_pending_prevents_deploy_and_public_readiness(self):
        operation = self.interrupt('after_journal')
        before = d.tree_snapshot(self.base)
        with self.assertRaisesRegex(m.ActivateError, 'activation_pending'):
            self.deployer.status()
        ready = m.READY.Context(self.home, user_home=self.account, manager=FixtureManager(self.bus),
                               processes=self.processes, transport=self.transport)
        with self.assertRaisesRegex(m.ActivateError, 'activation_pending'):
            ready.check(**self.options)
        self.assertEqual(d.tree_snapshot(self.base), before)
        self.assertEqual(self.pending(), operation)
        self.assertEqual(self.probes, 0)

    def test_same_account_other_home_cannot_deploy_around_activation(self):
        self.interrupt('after_journal')
        other = self.base/'other'; other.mkdir(mode=0o700)
        other_context = m.DEPLOY.Context(other, user_home=self.account, manager=self.fixture)
        before = d.tree_snapshot(self.base)
        with self.assertRaisesRegex(m.ActivateError, 'other_deployment_pending'):
            other_context.status()
        self.assertEqual(d.tree_snapshot(self.base), before)

    def test_crash_after_journal_recovers_not_dispatched_without_start(self):
        operation = self.interrupt('after_journal')
        self.assertEqual(self.context().status()['dispatch_state'], 'not_attempted')
        result = self.context().recover(operation)
        self.assertEqual(result['activation_outcome'], 'not_dispatched')
        self.assertEqual(result['dispatch_state'], 'not_attempted')
        self.assertIs(result['application_ready'], False)
        self.assertEqual(self.bus.starts, [])
        self.assertEqual(self.probes, 0)

    def test_crash_after_attempt_preserves_uncertainty_and_recovers_terminal(self):
        operation = self.interrupt('after_attempt')
        self.assertEqual(self.context().status()['dispatch_state'], 'outcome_unknown')
        result = self.context().recover(operation)
        self.assertEqual(result['activation_outcome'], 'not_running')
        self.assertEqual(result['dispatch_state'], 'outcome_unknown')
        self.assertEqual(self.bus.starts, [])

    def test_crash_after_start_before_ack_recovers_fresh_without_second_start(self):
        operation = self.interrupt('after_start_before_ack')
        self.assertEqual(self.context().status()['dispatch_state'], 'outcome_unknown')
        result = self.context().recover(operation)
        self.assertIs(result['application_ready'], True)
        self.assertEqual(result['dispatch_state'], 'outcome_unknown')
        self.assertEqual(len(self.bus.starts), 1)
        self.assertEqual(result['readiness']['console_pid'], 1234)

    def test_crash_after_ack_recovers_fresh_same_invocation_without_start(self):
        operation = self.interrupt('after_ack')
        self.assertEqual(self.context().status()['dispatch_state'], 'acknowledged')
        result = self.context().recover(operation)
        self.assertIs(result['application_ready'], True)
        self.assertEqual(result['readiness']['invocation_id'], INVOCATION)
        self.assertEqual(len(self.bus.starts), 1)

    def test_crash_after_receipt_finishes_history_without_claiming_fresh_ready(self):
        operation = self.interrupt('after_receipt')
        probes = self.probes
        self.transport_error = 'readiness_unverified'
        result = self.context().recover(operation)
        self.assertEqual(result['activation_outcome'], 'ready')
        self.assertEqual(result['application_ready'], 'not_checked')
        self.assertIsNone(result['readiness'])
        self.assertEqual(self.probes, probes)
        self.assertEqual(len(self.bus.starts), 1)
        self.assertEqual(self.context().status()['last_completed']['operation_sha256'], operation)

    def test_terminal_receipt_cleanup_does_not_claim_current_application_observation(self):
        operation = self.interrupt('after_journal')
        faults = []
        def interrupt_recovery(label):
            if label == 'after_receipt':
                faults.append(label)
                raise PowerLoss(label)
        with self.assertRaises(PowerLoss):
            self.context(fault=interrupt_recovery).recover(operation)
        self.assertEqual(faults, ['after_receipt'])
        receipt_path = self.operation(operation)/'receipt.json'
        committed = receipt_path.read_bytes()
        self.assertEqual(json.loads(committed)['outcome'], 'not_dispatched')
        self.assertEqual(self.pending(), operation)

        # An external account operator may change runtime after that receipt.
        # Cleanup fences the old sender but must report the receipt as history.
        self.bus.state('active', 'running', pid='1234')
        def forbid_observation():
            raise AssertionError('historical cleanup must not inspect application state')
        self.bus.before_show = forbid_observation
        self.transport_error = 'readiness_unverified'
        with patch.object(self.processes, 'database_snapshot', side_effect=forbid_observation), \
             patch.object(self.processes, 'console_snapshot', side_effect=forbid_observation):
            result = self.context().recover(operation)
        self.assertEqual(result['activation_outcome'], 'not_dispatched')
        self.assertEqual(result['dispatch_state'], 'not_attempted')
        self.assertEqual(result['application_ready'], 'not_checked')
        self.assertIsNone(result['readiness'])
        self.assertEqual(receipt_path.read_bytes(), committed)
        self.assertFalse((self.shared/'pending.json').exists())
        self.assertEqual(self.bus.starts, [])
        self.assertEqual(self.probes, 0)

    def test_crash_before_clear_pending_keeps_receipt_and_history_consistent(self):
        operation = self.interrupt('before_clear_pending')
        receipt_before = (self.operation(operation)/'receipt.json').read_bytes()
        history_before = (self.activation/'last.json').read_bytes()
        result = self.context().recover(operation)
        self.assertEqual(result['application_ready'], 'not_checked')
        self.assertEqual((self.operation(operation)/'receipt.json').read_bytes(), receipt_before)
        self.assertEqual((self.activation/'last.json').read_bytes(), history_before)
        self.assertFalse((self.shared/'pending.json').exists())

    def test_crash_after_clear_is_completed_and_cannot_be_recovered_again(self):
        self.assertIsNone(self.interrupt('after_clear_pending'))
        status = self.context().status()
        operation = status['last_completed']['operation_sha256']
        before = d.tree_snapshot(self.base)
        with self.assertRaisesRegex(m.ActivateError, 'pending_activation_mismatch'):
            self.context().recover(operation)
        self.assertEqual(d.tree_snapshot(self.base), before)
        self.assertEqual(len(self.bus.starts), 1)

    def test_lost_start_reply_never_retries_mutation_and_is_recoverable(self):
        def lost_reply():
            raise m.MANAGER.ActivateManagerError('activation_dispatch_uncertain')
        self.bus.after_start = lost_reply
        with self.assertRaisesRegex(m.MANAGER.ActivateManagerError, 'activation_dispatch_uncertain'):
            self.apply()
        operation = self.pending()
        self.bus.after_start = lambda: None
        self.assertEqual(self.context().status()['dispatch_state'], 'outcome_unknown')
        self.assertIs(self.context().recover(operation)['application_ready'], True)
        self.assertEqual(len(self.bus.starts), 1)

    def test_failed_terminal_console_can_complete_without_stop_or_restart(self):
        operation = self.interrupt('after_ack')
        self.bus.state('failed', 'failed')
        result = self.context().recover(operation)
        self.assertEqual(result['activation_outcome'], 'not_running')
        self.assertIs(result['application_ready'], False)
        self.assertEqual(len(self.bus.starts), 1)

    def test_queued_job_auto_restart_and_control_process_keep_reservation(self):
        operation = self.interrupt('after_ack')
        for state, sub, pid, control, job in (
                ('activating', 'start', '0', 0, '42'),
                ('activating', 'auto-restart', '0', 0, ''),
                ('inactive', 'dead', '0', 3456, ''),
                ('failed', 'failed', '1234', 0, '')):
            self.bus.state(state, sub, pid=pid)
            self.bus.control_pid = control
            self.fixture.overrides[s.CONSOLE]['Job'] = job
            with self.subTest(state=state, sub=sub, pid=pid, control=control):
                self.assert_recovery_refused(operation)

    def test_live_old_sender_and_fence_errors_never_clear_pending(self):
        operation = self.interrupt('after_ack')
        sender = json.loads((self.operation()/'intent.json').read_bytes())['sender_name']
        self.bus.connections.add(sender)
        self.assert_recovery_refused(operation, pattern='activation_sender_still_connected')
        self.bus.connections.discard(sender)
        for error in ('sender_lookup_unverified', 'fence_timeout', 'manager_unavailable'):
            self.bus.fence_error = error
            with self.subTest(error=error):
                self.assert_recovery_refused(operation, pattern=error)

    def test_boot_bus_owner_or_manager_process_change_never_clears_pending(self):
        operation = self.interrupt('after_ack')
        original = copy.deepcopy(self.bus.identity)
        for key in ('boot_id', 'bus_id', 'manager_owner', 'manager_pid', 'manager_start_ticks', 'uid'):
            self.bus.identity = copy.deepcopy(original)
            value = self.bus.identity[key]
            self.bus.identity[key] = value+1 if type(value) is int else value+'1'
            with self.subTest(key=key):
                self.assert_recovery_refused(operation, pattern='manager_identity_changed')

    def test_wrong_pending_digest_is_read_only_and_does_not_connect(self):
        operation = self.interrupt('after_ack')
        self.bus.offline = True
        before = d.tree_snapshot(self.base)
        with self.assertRaisesRegex(m.ActivateError, 'pending_activation_mismatch'):
            self.context().recover('f'*64)
        self.assertEqual(d.tree_snapshot(self.base), before)
        self.assertEqual(self.pending(), operation)
        self.assertFalse(self.managers[-1].connected)

    def test_status_reads_pending_and_history_while_manager_is_offline(self):
        operation = self.interrupt('after_receipt')
        self.bus.offline = True
        before = d.tree_snapshot(self.base)
        result = self.context().status()
        self.assertEqual(result['pending_sha256'], operation)
        self.assertTrue(result['receipt_committed'])
        self.assertEqual(result['application_ready'], 'not_checked')
        self.assertEqual(result['manager_observation'], 'not_checked')
        self.assertFalse(self.managers[-1].connected)
        self.assertEqual(d.tree_snapshot(self.base), before)

    def test_missing_or_changed_token_blocks_recovery_until_original_restored(self):
        operation = self.interrupt('after_ack')
        self.token.write_text('a'*64+'\n')
        self.assert_recovery_refused(operation, pattern='activation_binding_changed')
        self.token.unlink()
        self.assert_recovery_refused(operation)
        self.token.write_text(TOKEN+'\n'); self.token.chmod(0o600)
        self.assertIs(self.context().recover(operation)['application_ready'], True)
        self.assertEqual(len(self.bus.starts), 1)

    def test_changed_database_process_blocks_recovery(self):
        operation = self.interrupt('after_ack')
        self.database['postmaster']['start_ticks'] += 1
        self.assert_recovery_refused(operation, pattern='activation_binding_changed')

    def test_changed_source_locks_block_recovery(self):
        operation = self.interrupt('after_ack')
        pins = m.PREFLIGHT.check_pins(ROOT)
        changed = {**pins, 'fixture_changed_source_lock': True}
        with patch.object(m.PREFLIGHT, 'check_pins', return_value=changed):
            self.assert_recovery_refused(operation, pattern='activation_binding_changed')

    def test_wrong_expected_instance_starts_once_but_cannot_be_accepted(self):
        # The installed PostgreSQL process is checked before dispatch, while its
        # logical instance UUID is authenticated by the running console response.
        self.options['expected_instance'] = INSTANCE[:-1]+'2'
        with patch.object(m.time, 'sleep'), self.assertRaisesRegex(
                m.ActivateError, 'activation_not_ready_recovery_required'):
            self.apply()
        operation = self.pending()
        self.assertEqual(len(self.bus.starts), 1)
        self.assertFalse((self.operation()/'receipt.json').exists())
        self.assert_recovery_refused(operation)
        self.assertEqual(len(self.bus.starts), 1)

    def test_wrong_authenticated_source_or_unavailable_source_keeps_pending(self):
        operation = self.interrupt('after_ack')
        self.response_updates = {'source_id': 'foreign'}
        self.assert_recovery_refused(operation)
        self.response_updates = {}
        self.transport_error = 'readiness_unverified'
        self.assert_recovery_refused(operation, pattern='readiness_unverified')
        self.transport_error = None
        self.assertIs(self.context().recover(operation)['application_ready'], True)
        self.assertEqual(len(self.bus.starts), 1)

    def test_changed_generation_link_or_cached_configuration_keeps_pending(self):
        operation = self.interrupt('after_ack')
        self.fixture.overrides[s.CONSOLE]['NeedDaemonReload'] = 'yes'
        self.assert_recovery_refused(operation, pattern='unit_manager_binding_mismatch')
        self.fixture.overrides[s.CONSOLE]['NeedDaemonReload'] = 'no'
        path = self.units/s.CONSOLE
        target = os.readlink(path)
        replacement = self.units/'replacement'
        replacement.symlink_to(target); os.replace(replacement, path)
        self.assert_recovery_refused(operation, pattern='activation_binding_changed')

    def test_changed_cached_contract_or_other_unit_runtime_keeps_pending(self):
        operation = self.interrupt('after_ack')
        original = copy.deepcopy(self.bus.contract)
        self.bus.contract['start'].append('unexpected.service')
        self.assert_recovery_refused(operation, pattern='activation_contract_changed')
        self.bus.contract = original
        self.bus.database_runtime['MainPID'] = 4567
        self.assert_recovery_refused(operation, pattern='activation_dependency_changed')

    def test_invocation_change_during_readiness_does_not_commit_receipt(self):
        operation = self.interrupt('after_ack')
        self.after_probe = lambda: setattr(self.bus, 'invocation', '45'*16)
        self.assert_recovery_refused(operation, pattern='installation_changed_during_check|activation_console_changed')
        self.assertFalse((self.operation()/'receipt.json').exists())

    def test_manager_change_after_fence_during_probe_keeps_pending(self):
        operation = self.interrupt('after_ack')
        self.after_probe = lambda: self.bus.identity.update(manager_owner=':1.999')
        self.assert_recovery_refused(operation, pattern='activation_binding_changed|manager_identity_changed')
        self.assertFalse((self.operation()/'receipt.json').exists())

    def test_token_change_during_probe_does_not_commit_receipt(self):
        operation = self.interrupt('after_ack')
        self.after_probe = lambda: self.token.write_text('a'*64+'\n')
        with self.assertRaises(Exception):
            self.context().recover(operation)
        self.assertEqual(self.pending(), operation)
        self.assertFalse((self.operation()/'receipt.json').exists())
        self.assertEqual(len(self.bus.starts), 1)

    def test_post_journal_binding_change_prevents_dispatch_and_remains_recoverable(self):
        def rotate(label):
            if label == 'after_journal':
                self.token.write_text('a'*64+'\n')
        with self.assertRaisesRegex(m.ActivateError, 'activation_plan_mismatch'):
            self.apply(fault=rotate)
        operation = self.pending()
        self.assertEqual(self.bus.starts, [])
        self.assertFalse((self.operation()/'attempt.json').exists())
        self.token.write_text(TOKEN+'\n')
        self.assertEqual(self.context().recover(operation)['activation_outcome'], 'not_dispatched')

    def test_readiness_retries_are_bounded_and_never_retry_start(self):
        self.transport_error = 'readiness_unverified'
        with patch.object(m.time, 'sleep'), self.assertRaisesRegex(
                m.ActivateError, 'activation_not_ready_recovery_required'):
            self.apply()
        self.assertGreater(self.probes, 0)
        self.assertLessEqual(self.probes, 20)
        self.assertEqual(len(self.bus.starts), 1)
        self.assertTrue((self.shared/'pending.json').exists())

    def test_receipt_persistence_failure_is_not_retried_as_readiness(self):
        failures = []
        def fault(label):
            if label == 'after_receipt':
                failures.append(label)
                raise OSError('fixture_receipt_io_failure')
        with patch.object(m.time, 'sleep'), self.assertRaisesRegex(
                OSError, 'fixture_receipt_io_failure'):
            self.apply(fault=fault)
        self.assertEqual(failures, ['after_receipt'])
        self.assertEqual(self.probes, 1)
        self.assertEqual(len(self.bus.starts), 1)
        self.assertTrue(self.context().status()['receipt_committed'])
        operation = self.pending()
        self.transport_error = 'readiness_unverified'
        result = self.context().recover(operation)
        self.assertEqual(result['application_ready'], 'not_checked')
        self.assertEqual(self.probes, 1)
        self.assertFalse((self.shared/'pending.json').exists())

    def test_lock_blocks_competing_writer_through_dispatch_probe_and_close(self):
        blocked = []
        def verify_lock(label):
            with self.assertRaisesRegex(m.ActivateError, 'deployment_busy'):
                with m.DEPLOY.Context(self.home, user_home=self.account)._lock(write=True):
                    self.fail('writer acquired activation lock')
            blocked.append(label)
        plan = self.plan()
        context = self.context()
        context.manager.close_hook = lambda: verify_lock('close')
        self.bus.after_start = lambda: verify_lock('dispatch')
        self.after_probe = lambda: verify_lock('probe')
        context.apply(expected_plan=plan['activation_plan_sha256'], **self.options)
        self.assertEqual(blocked, ['dispatch', 'probe', 'close'])
        with m.DEPLOY.Context(self.home, user_home=self.account)._lock(write=True):
            pass

    def test_existing_exclusive_lock_refuses_plan_apply_status_and_recovery(self):
        with open(self.shared/'lock', 'rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for action in (lambda: self.plan(), lambda: self.apply(expected_plan='f'*64),
                           lambda: self.context().status(), lambda: self.context().recover('f'*64)):
                with self.subTest(action=action), self.assertRaisesRegex(m.ActivateError, 'deployment_busy'):
                    action()
        self.assertEqual(self.bus.starts, [])
        self.assertFalse(any(manager.connected for manager in self.managers))

    def test_readiness_internal_composition_requires_a_held_verified_lock(self):
        self.bus.state('active', 'running', pid='1234')
        with self.assertRaisesRegex(m.ActivateError, 'deployment_lock_missing'):
            self.context()._check_locked(**self.options)
        self.assertEqual(self.probes, 0)

    def test_missing_deployment_lock_is_not_created(self):
        (self.shared/'lock').unlink()
        before = d.tree_snapshot(self.base)
        with self.assertRaisesRegex(m.ActivateError, 'state_file_missing'):
            self.context().status()
        self.assertEqual(d.tree_snapshot(self.base), before)
        self.assertFalse(any(manager.connected for manager in self.managers))

    def test_invalid_reservation_schema_is_rejected_without_bus_access(self):
        self.interrupt('after_journal')
        path = self.shared/'pending.json'
        original = json.loads(path.read_bytes())
        for changes in ({'format': True}, {'format': 1}, {'extra': False},
                        {'operation_sha256': 'not-a-sha'}):
            self.write_json(path, {**original, **changes})
            with self.subTest(changes=changes), self.assertRaises(Exception):
                self.context().status()
            self.assertFalse(self.managers[-1].connected)

    def test_attempt_requires_integer_format_not_boolean(self):
        operation = self.interrupt('after_attempt')
        self.write_json(self.operation()/'attempt.json', {'format': True, 'operation_sha256': operation})
        with self.assertRaisesRegex(m.ActivateError, 'invalid_activation_attempt'):
            self.context().status()

    def test_ack_requires_attempt_and_exact_typed_job_record(self):
        operation = self.interrupt('after_ack')
        path = self.operation()/'ack.json'
        original = json.loads(path.read_bytes())
        for changes in ({'format': True}, {'job_path': '/org/freedesktop/systemd1/job/0'},
                        {'job_path': 42}, {'operation_sha256': 'f'*64}, {'extra': True}):
            self.write_json(path, {**original, **changes})
            with self.subTest(changes=changes), self.assertRaisesRegex(
                    m.ActivateError, 'invalid_activation_acknowledgement'):
                self.context().status()
        self.write_json(path, original)
        (self.operation()/'attempt.json').unlink()
        with self.assertRaisesRegex(m.ActivateError, 'invalid_activation_acknowledgement'):
            self.context().status()

    def test_receipt_cannot_claim_not_dispatched_after_attempt(self):
        operation = self.interrupt('after_receipt')
        path = self.operation()/'receipt.json'
        value = json.loads(path.read_bytes())
        value.update(outcome='not_dispatched', readiness=None)
        self.write_json(path, value)
        with self.assertRaisesRegex(m.ActivateError, 'invalid_activation_receipt'):
            self.context().status()

    def test_ready_receipt_requires_original_instance_source_and_complete_proof_scope(self):
        self.interrupt('after_receipt')
        path = self.operation()/'receipt.json'
        original = json.loads(path.read_bytes())
        for readiness in ({'application_ready': True, 'invocation_id': INVOCATION},
                          {**original['readiness'], 'instance_id': INSTANCE[:-1]+'2'},
                          {**original['readiness'], 'source_id': 'foreign'},
                          {**original['readiness'], 'current_sha256': 'f'*64},
                          {**original['readiness'], 'console_pid': True},
                          {**original['readiness'], 'authenticated_console_ready': False}):
            self.write_json(path, {**original, 'readiness': readiness})
            with self.subTest(readiness=readiness), self.assertRaisesRegex(
                    m.ActivateError, 'invalid_activation_receipt'):
                self.context().status()

    def test_intent_digest_does_not_authorize_a_different_action_contract(self):
        operation = self.interrupt('after_journal')
        initial = json.loads((self.operation()/'intent.json').read_bytes())
        pointer = json.loads((self.shared/'pending.json').read_bytes())
        for changes in ({'format': True}, {'worker_authorized': True},
                        {'starts': [s.WORKER]}, {'target_started': True}, {'unknown': False}):
            value = copy.deepcopy(initial)
            value['plan'].update(changes)
            value['plan']['activation_plan_sha256'] = m.FS.digest(
                {k: v for k, v in value['plan'].items() if k != 'activation_plan_sha256'})
            rebound = m.FS.digest(value)
            destination = self.operation(rebound)
            destination.mkdir(mode=0o700)
            self.write_json(destination/'intent.json', value)
            self.write_json(self.shared/'pending.json', {**pointer, 'operation_sha256': rebound})
            with self.subTest(changes=changes), self.assertRaisesRegex(
                    m.ActivateError, 'invalid_activation_intent'):
                self.context().status()
        self.assertEqual(self.bus.starts, [])

    def test_receipt_or_intent_symlink_is_not_followed(self):
        self.interrupt('after_receipt')
        for name in ('receipt.json', 'intent.json'):
            path = self.operation()/name
            destination = path.with_suffix('.saved')
            path.rename(destination); path.symlink_to(destination)
            with self.subTest(name=name), self.assertRaises(Exception):
                self.context().status()
            path.unlink(); destination.rename(path)


class CliTests(unittest.TestCase):
    def run_cli(self, argv, *, uid=1000, euid=1000, platform='linux', error=None):
        calls = []
        manager = SimpleNamespace(close=lambda: calls.append(('close',)))
        def invoke(action, *args, **kwargs):
            calls.append((action, args, kwargs))
            if error:
                raise error
            return {'fixture_action': action}
        context = SimpleNamespace(manager=manager,
            plan=lambda **kw: invoke('plan', **kw),
            apply=lambda **kw: invoke('apply', **kw),
            status=lambda: invoke('status'), recover=lambda pending: invoke('recover', pending))
        def factory(home):
            calls.append(('context', home))
            return context
        output = io.StringIO()
        with patch.object(m.os, 'getuid', return_value=uid), \
             patch.object(m.os, 'geteuid', return_value=euid), \
             patch.object(m.sys, 'platform', platform), \
             patch.object(m.pwd, 'getpwuid', return_value=SimpleNamespace(pw_dir='/fixture/account')), \
             contextlib.redirect_stdout(output):
            code = m.main(argv, context_factory=factory)
        return code, json.loads(output.getvalue()), calls

    def plan_flags(self):
        return ['--home', '/fixture/data', '--bun', '/usr/bin/bun',
                '--expected-current', 'a'*64, '--expected-instance', INSTANCE]

    def test_each_action_has_explicit_dispatch_and_context_is_closed(self):
        for argv, action in ((['plan', *self.plan_flags()], 'plan'),
                             (['apply', *self.plan_flags(), '--expected-plan', 'b'*64], 'apply'),
                             (['status', '--home', '/fixture/data'], 'status'),
                             (['recover', '--home', '/fixture/data', '--expected-pending', 'c'*64], 'recover')):
            code, value, calls = self.run_cli(argv)
            with self.subTest(action=action):
                self.assertEqual(code, 0)
                self.assertTrue(value['ok'])
                self.assertEqual(calls[1][0], action)
                self.assertEqual(calls[-1], ('close',))

    def test_cli_defaults_and_explicit_source_are_preserved(self):
        code, _, calls = self.run_cli(['plan', *self.plan_flags()])
        self.assertEqual(code, 0)
        self.assertEqual(calls[1][2]['source'], 'default')
        self.assertEqual(calls[1][2]['port'], 3132)
        code, _, calls = self.run_cli(['plan', *self.plan_flags(), '--source', 'personal', '--port', '4132'])
        self.assertEqual(code, 0)
        self.assertEqual(calls[1][2]['source'], 'personal')
        self.assertEqual(calls[1][2]['port'], 4132)

    def test_root_uid_mismatch_and_non_linux_refuse_before_context(self):
        for identity in ({'uid': 0, 'euid': 0}, {'uid': 1000, 'euid': 0},
                         {'uid': 1001, 'euid': 1000}, {'platform': 'win32'}):
            code, result, calls = self.run_cli(['status'], **identity)
            with self.subTest(identity=identity):
                self.assertEqual(code, 1)
                self.assertEqual(result['error'], 'ordinary_linux_account_required')
                self.assertEqual(calls, [])

    def test_wrong_action_options_abbreviations_duplicates_and_missing_guards_refuse(self):
        cases = ([], ['activate'], ['apply', *self.plan_flags()], ['recover'],
                 ['plan', '--bun', '/usr/bin/bun'], ['status', '--bun', '/usr/bin/bun'],
                 ['recover', '--expected-pending', 'c'*64, '--source', 'personal'],
                 ['status', '--ho', '/fixture/data'], ['status', '--home', '/one', '--home=/two'],
                 ['plan', *self.plan_flags(), '--expected-plan', 'b'*64],
                 ['status', '--expected-pending', 'c'*64])
        for argv in cases:
            code, result, calls = self.run_cli(argv)
            with self.subTest(argv=argv):
                self.assertEqual(code, 1)
                self.assertEqual(result['error'], 'invalid_arguments')
                self.assertEqual(calls, [])

    def test_unexpected_error_is_redacted_and_does_not_deny_possible_start(self):
        secret = 'private token and raw D-Bus payload'
        code, result, calls = self.run_cli(['status'], error=RuntimeError(secret))
        self.assertEqual(code, 1)
        self.assertEqual(result['error'], 'personal_activation_failed')
        self.assertEqual(result['activation_outcome'], 'not_proven')
        self.assertNotIn(secret, json.dumps(result))
        self.assertNotIn('services_started', result)
        self.assertEqual(calls[-1], ('close',))


if __name__ == '__main__':
    unittest.main()
