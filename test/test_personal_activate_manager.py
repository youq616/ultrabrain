import copy
import importlib.util
from pathlib import Path
import time
import unittest


SPEC = importlib.util.spec_from_file_location('activation_manager',
    Path(__file__).resolve().parents[1]/'scripts/personal_activate_manager.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)

ARGS = {'root': '/repo', 'home': '/private/brain', 'bun': '/opt/bun', 'source': 'personal', 'port': 3132}
BOOT = '11111111-2222-3333-4444-555555555555'


def unit(name, *, active=True):
    value = {key: [] for key in M.EDGES}
    value.update({'Id': name, 'Names': [name], 'LoadState': 'loaded',
                  'FragmentPath': '/units/'+name, 'DropInPaths': [], 'NeedDaemonReload': False,
                  'Following': '', 'StopWhenUnneeded': False, 'RefuseManualStart': False,
                  'RefuseManualStop': False, 'DefaultDependencies': True,
                  'FailureAction': 'none', 'SuccessAction': 'none', 'StartLimitAction': 'none',
                  'JobTimeoutAction': 'none', 'JobTimeoutUSec': 2**64-1, 'JobRunningTimeoutUSec': 2**64-1,
                  'StartLimitIntervalUSec': 300_000_000, 'StartLimitBurst': 3,
                  'ActiveState': 'active' if active else 'inactive',
                  'SubState': 'active' if active else 'dead', 'Job': [0, '/'],
                  'InvocationID': [1]*16 if active else []})
    return value


def service():
    return {'MainPID': 0, 'ControlPID': 0, 'ControlGroup': '', 'NRestarts': 0}


def console_service():
    value = service()
    value.update(copy.deepcopy(M.SERVICE_VALUES))
    for key in M.EXEC_LISTS:
        value[key], value[key+'Ex'] = [], []
    argv = ['/usr/bin/env', '-u', 'DATABASE_URL', '-u', 'GBRAIN_DATABASE_URL', '-u', 'NODE_OPTIONS',
            '-u', 'BUN_OPTIONS', '-u', 'PYTHONPATH', '-u', 'PYTHONHOME', '--',
            'ULTRABRAIN_HOME=/private/brain', 'GBRAIN_SOURCE=personal', 'GBRAIN_HOME=/private/brain/gbrain',
            'GBRAIN_SWEEP=0', 'GBRAIN_SELF_UPGRADE_MODE=off', 'ULTRABRAIN_MCP_PROFILE=compatibility',
            'ULTRABRAIN_DEBUG=0', '/opt/bun', '--no-env-file', '/repo/src/cli.mjs', 'personal-ui',
            '--source', 'personal', '--port', '3132']
    value['ExecStart'] = [['/usr/bin/env', argv, False, 0, 0, 0, 0, 0, 0, 0]]
    value['ExecStartEx'] = [['/usr/bin/env', list(argv), [], 0, 0, 0, 0, 0, 0, 0]]
    return value


class BusFailure(Exception):
    def __init__(self, name='org.freedesktop.DBus.Error.NoReply'):
        self.name = name

    def get_dbus_name(self):
        return self.name


class FakeMessage:
    def __init__(self, destination, path, interface, method):
        self.destination, self.path, self.interface, self.method = destination, path, interface, method
        self.auto_start = self.interactive = True
        self.serial = 0

    def set_auto_start(self, value):
        self.auto_start = value

    def set_allow_interactive_authorization(self, value):
        self.interactive = value

    def append(self, *args, signature):
        self.args, self.signature = args, signature

    def get_serial(self):
        return self.serial


class FakeReply:
    def __init__(self, request, value):
        self.sender, self.serial = request.destination, request.serial
        self.signature = {'GetId': 's', 'GetNameOwner': 's', 'GetConnectionUnixUser': 'u',
                          'GetConnectionUnixProcessID': 'u', 'LoadUnit': 'o', 'StartUnit': 'o',
                          'Get': 'v', 'GetAll': 'a{sv}', 'Ping': ''}[request.method]
        self.values = [] if self.signature == '' else [value]

    def get_sender(self):
        return self.sender

    def get_signature(self):
        return self.signature

    def get_reply_serial(self):
        return self.serial

    def get_args_list(self):
        return self.values


class FakeBus:
    def __init__(self):
        self.calls, self.closed, self.exit_on_disconnect = [], False, None
        self.owner, self.uid, self.bus_id, self.version = ':1.4', 1000, '1'*32, '255.4-1ubuntu8.11'
        self.sender = ':1.90'
        self.start_result = '/org/freedesktop/systemd1/job/123'
        self.start_failure = None
        self.mutate = None
        self.old_sender_exists = False
        self.lookup_failure = None
        self.messages, self.reply_fault = [], None
        self.units = {name: unit(name) for name in ('basic.target', 'sockets.target', 'dbus.socket',
                                                   'app.slice', '-.slice', M.DATABASE)}
        self.units['app.slice']['Requires'] = ['-.slice']
        self.units['basic.target']['Wants'] = ['sockets.target']
        self.units['sockets.target']['Wants'] = ['dbus.socket']
        self.units['shutdown.target'] = unit('shutdown.target', active=False)
        self.units[M.CONSOLE] = unit(M.CONSOLE, active=False)
        self.units[M.CONSOLE].update({'Requires': [M.DATABASE, 'basic.target', 'app.slice'],
                                     'PartOf': [M.TARGET, M.DATABASE],
                                     'After': [M.DATABASE, 'basic.target'],
                                     'Conflicts': ['shutdown.target'], 'Before': ['shutdown.target']})
        self.units[M.DATABASE]['Requires'] = ['basic.target']
        self.units[M.DATABASE]['SubState'] = 'exited'
        self.units[M.TARGET] = unit(M.TARGET, active=False)
        self.units[M.WORKER] = unit(M.WORKER, active=False)
        self.units[M.WORKER].update({'LoadState': 'not-found', 'FragmentPath': ''})
        self.services = {M.CONSOLE: console_service(),
                         M.DATABASE: {**service(), 'Type': 'oneshot', 'RemainAfterExit': True}}
        self.paths = {name: '/org/freedesktop/systemd1/unit/'+str(i)
                      for i, name in enumerate(self.units)}
        self.reads = {}

    def set_exit_on_disconnect(self, value):
        self.exit_on_disconnect = value

    def get_unique_name(self):
        return self.sender

    def close(self):
        self.closed = True

    def add(self, name, *, active=True):
        self.units[name] = unit(name, active=active)
        self.paths[name] = '/org/freedesktop/systemd1/unit/'+str(len(self.paths))
        if name.endswith('.service'):
            self.services[name] = {**service(), 'MainPID': 321 if active else 0}

    # dbus-python 1.3.2 exposes this C method as METH_VARARGS, without
    # METH_KEYWORDS. A Python fake accepting keywords hid a real CI failure.
    def send_message_with_reply_and_block(self, message, timeout_s, /):
        if message.auto_start is not False or message.interactive is not False:
            raise AssertionError('Implicit activation or interactive authorization')
        self.messages.append(message)
        message.serial = len(self.messages)
        value = self.call_blocking(message.destination, message.path, message.interface, message.method,
                                   message.signature, message.args, timeout=timeout_s)
        reply = FakeReply(message, value)
        if self.reply_fault:
            self.reply_fault(message, reply)
        return reply

    def call_blocking(self, destination, path, interface, method, signature, args, *, timeout):
        self.calls.append((destination, path, interface, method, signature, tuple(args), timeout))
        if not 0 < timeout <= 5:
            raise AssertionError('Unbounded timeout')
        if destination == M.BUS:
            if method == 'GetId':
                return self.bus_id
            if method == 'GetNameOwner':
                if args[0] == 'org.freedesktop.systemd1':
                    return self.owner
                if self.lookup_failure:
                    raise BusFailure(self.lookup_failure)
                if self.old_sender_exists:
                    return args[0]
                raise BusFailure('org.freedesktop.DBus.Error.NameHasNoOwner')
            if method == 'GetConnectionUnixUser':
                return self.uid
            if method == 'GetConnectionUnixProcessID':
                return 345
            raise AssertionError(method)
        if destination != ':1.4':
            raise AssertionError('Followed another manager owner')
        if method == 'LoadUnit':
            return self.paths[args[0]]
        if method == 'Get':
            if args[1] == 'Version':
                return self.version
            if args[1] == 'UnitPath':
                return ['/home/service/.config/systemd/user', '/usr/lib/systemd/user']
            name = next(n for n, p in self.paths.items() if p == path)
            return copy.deepcopy(self.units[name][args[1]])
        if method == 'GetAll':
            name = next(n for n, p in self.paths.items() if p == path)
            self.reads[(name, args[0])] = self.reads.get((name, args[0]), 0)+1
            if self.mutate:
                self.mutate(name, args[0], self)
            return copy.deepcopy((self.units if args[0] == M.UNIT else self.services)[name])
        if method == 'StartUnit':
            if self.start_failure:
                raise BusFailure(self.start_failure)
            return self.start_result
        if method == 'Ping':
            return None
        raise AssertionError(method)


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.bus = FakeBus()
        self.manager = M.LocalManager(_connection=self.bus, _uid=1000, _boot_id=BOOT,
                                     _process_probe=lambda pid, uid: {'pid': pid, 'uid': uid, 'start_ticks': 100},
                                     _message_factory=FakeMessage)

    def tearDown(self):
        self.manager.close()

    def fails(self, code, function=None):
        with self.assertRaisesRegex(M.ActivateManagerError, '^'+code+'$'):
            (function or (lambda: self.manager.inspect_start_graph(**ARGS)))()

    def test_lazy_construction_and_close_need_no_bus(self):
        self.assertEqual(self.bus.calls, [])
        self.assertFalse(hasattr(self.manager, 'connection'))
        self.manager.close()
        self.assertFalse(self.bus.closed)

    def test_same_uid_owner_and_direct_identity(self):
        self.assertEqual(self.manager.connection_identity(),
                         {'boot_id': BOOT, 'bus_id': '1'*32, 'manager_owner': ':1.4'})
        self.assertEqual(self.manager.sender_name, ':1.90')
        self.assertIs(self.bus.exit_on_disconnect, False)

    def test_foreign_manager_uid_refused(self):
        self.bus.uid = 1001
        self.fails('manager_owner_uid_mismatch', self.manager.connection_identity)
        self.assertTrue(self.bus.closed)

    def test_unproven_systemd_version_refused(self):
        self.bus.version = '256.1'
        self.fails('unsupported_manager_version', self.manager.connection_identity)

    def test_owner_replacement_does_not_retarget_methods(self):
        self.manager.connection_identity()
        self.bus.owner = ':1.999'
        self.fails('manager_identity_changed', self.manager.start_console)
        self.assertFalse(any(c[3] == 'StartUnit' for c in self.bus.calls))

    def test_bus_replacement_refused(self):
        self.manager.connection_identity()
        self.bus.bus_id = '2'*32
        self.fails('manager_identity_changed', self.manager.connection_identity)

    def test_expired_deadline_sends_nothing(self):
        self.manager.deadline = time.monotonic()-1
        self.fails('manager_timeout', self.manager.start_console)
        self.assertEqual(self.bus.calls, [])

    def test_ready_show_compatibility_is_read_only(self):
        rows = self.manager('show')
        self.assertEqual(set(rows), set(M.PERSONAL))
        self.assertEqual(rows[M.WORKER]['LoadState'], 'not-found')
        self.assertEqual(self.manager.console['MainPID'], '0')
        self.assertEqual(set(self.manager.console), set(M.DETAIL))
        self.assertFalse(any(c[3] == 'StartUnit' for c in self.bus.calls))

    def test_stopped_start_graph_includes_active_database_descendants(self):
        result = self.manager.inspect_start_graph(**ARGS)
        self.assertIn('dbus.socket', result['contract']['start_units'])
        self.assertIn('-.slice', result['contract']['start_units'])
        self.assertEqual(result['contract']['stop_units'], ['shutdown.target'])
        self.assertEqual(result['observation'][M.DATABASE]['SubState'], 'exited')
        self.assertFalse(any(c[3] == 'StartUnit' for c in self.bus.calls))

    def test_active_database_does_not_hide_inactive_dependency(self):
        self.bus.add('extra.service', active=False)
        self.bus.units[M.DATABASE]['Wants'] = ['extra.service']
        self.fails('activation_dependency_not_ready')

    def test_worker_reachable_through_active_basic_is_refused(self):
        self.bus.units['basic.target']['Wants'].append(M.WORKER)
        self.fails('unexpected_activation_unit')

    def test_mcp_reachable_through_database_is_refused(self):
        self.bus.add('ultrabrain-mcp.service')
        self.bus.units[M.DATABASE]['Requires'].append('ultrabrain-mcp.service')
        self.fails('unexpected_activation_unit')

    def test_canonical_device_hides_reverse_follower_worker(self):
        # v255 device_following() returns NULL for the canonical sys-* name,
        # but transaction_add_job_and_dependencies() traverses following_set()
        # too. Its dev-* sibling can therefore pull in a hidden Worker start.
        canonical, sibling = 'sys-devices-virtual-review.device', 'dev-review.device'
        self.bus.add(canonical)
        self.bus.add(sibling)
        self.bus.units['basic.target']['Wants'].append(canonical)
        self.bus.units[sibling]['Following'] = canonical
        self.bus.units[sibling]['Wants'] = [M.WORKER]
        self.assertEqual(self.bus.units[canonical]['Following'], '')
        self.fails('unsupported_activation_unit')
        self.assertFalse(any(c[3] == 'StartUnit' for c in self.bus.calls))

    def test_swap_dependency_is_not_supported(self):
        swap = 'dev-review.swap'
        self.bus.add(swap)
        self.bus.units['basic.target']['Wants'].append(swap)
        self.fails('unsupported_activation_unit')
        self.assertFalse(any(c[3] == 'LoadUnit' and c[5] == (swap,) for c in self.bus.calls))
        self.assertFalse(any(c[3] == 'StartUnit' for c in self.bus.calls))

    def test_swap_stop_closure_is_refused_before_loading(self):
        swap = 'dev-review.swap'
        self.bus.add(swap)
        self.bus.units['shutdown.target']['RequiredBy'].append(swap)
        self.fails('unsupported_activation_unit')
        self.assertFalse(any(c[3] == 'LoadUnit' and c[5] == (swap,) for c in self.bus.calls))
        self.assertFalse(any(c[3] == 'StartUnit' for c in self.bus.calls))

    def test_swap_verify_closure_is_refused_before_loading(self):
        swap = 'dev-review.swap'
        self.bus.add(swap)
        self.bus.units['basic.target']['Requisite'].append(swap)
        self.fails('unsupported_activation_unit')
        self.assertFalse(any(c[3] == 'LoadUnit' and c[5] == (swap,) for c in self.bus.calls))
        self.assertFalse(any(c[3] == 'StartUnit' for c in self.bus.calls))

    def test_root_slice_records_passive_swap_without_loading_it(self):
        # v255 enumerates /proc/swaps in user managers too. Such extrinsic
        # units require/order after -.slice, even when this transaction only
        # starts an already active root slice and never reaches the swap.
        swap = 'dev-review.swap'
        self.bus.add(swap)
        self.bus.units[swap]['Requires'] = ['-.slice']
        self.bus.units[swap]['After'] = ['-.slice']
        self.bus.units['-.slice']['RequiredBy'].append(swap)
        self.bus.units['-.slice']['Before'].append(swap)
        graph = self.manager.inspect_start_graph(**ARGS)
        self.assertIn(swap, graph['contract']['units']['-.slice']['RequiredBy'])
        self.assertIn(swap, graph['contract']['units']['-.slice']['Before'])
        self.assertNotIn(swap, graph['contract']['units'])
        self.assertNotIn(swap, graph['observation'])
        for key in ('start_units', 'stop_units', 'verify_units'):
            self.assertNotIn(swap, graph['contract'][key])
        self.assertFalse(any(c[3] == 'LoadUnit' and c[5] == (swap,) for c in self.bus.calls))
        self.assertFalse(any(c[3] == 'StartUnit' for c in self.bus.calls))

    def test_conflict_cannot_stop_active_foreign_unit(self):
        self.bus.add('editor.service')
        self.bus.units[M.DATABASE]['ConflictedBy'] = ['editor.service']
        self.fails('activation_dependency_not_ready')

    def test_inactive_conflict_stop_propagation_is_traversed(self):
        self.bus.add('editor.service')
        self.bus.units['shutdown.target']['ConsistsOf'] = ['editor.service']
        self.fails('activation_dependency_not_ready')

    def test_requisite_does_not_pull_its_own_dependencies(self):
        self.bus.add('verified.target')
        self.bus.units['verified.target']['Requires'] = ['unloaded.service']
        self.bus.units[M.DATABASE]['Requisite'] = ['verified.target']
        result = self.manager.inspect_start_graph(**ARGS)
        self.assertEqual(result['contract']['verify_units'], ['verified.target'])
        self.assertNotIn('unloaded.service', result['contract']['units'])

    def test_dependency_stop_when_unneeded_refused(self):
        self.bus.units[M.DATABASE]['StopWhenUnneeded'] = True
        self.fails('dependency_stop_when_unneeded')

    def test_console_failure_callback_refused(self):
        self.bus.units[M.CONSOLE]['OnFailure'] = ['callback.service']
        self.fails('console_dependency_side_effect')

    def test_job_timeout_cannot_exit_user_manager(self):
        self.bus.units[M.CONSOLE]['JobTimeoutAction'] = 'exit'
        self.fails('console_cache_mismatch')

    def test_console_reverse_stop_dependency_refused(self):
        self.bus.units[M.CONSOLE]['RequiredBy'] = ['editor.service']
        self.fails('console_dependency_side_effect')

    def test_queued_job_refused(self):
        self.bus.units[M.DATABASE]['Job'] = [22, '/org/freedesktop/systemd1/job/22']
        self.fails('activation_unit_not_stable')

    def test_cached_reload_requirement_refused(self):
        self.bus.units[M.CONSOLE]['NeedDaemonReload'] = True
        self.fails('activation_unit_not_stable')

    def test_extra_cached_start_command_refused(self):
        self.bus.services[M.CONSOLE]['ExecStartPre'] = [['/bin/touch', ['/bin/touch', '/tmp/side-effect'], False, 0, 0, 0, 0, 0, 0, 0]]
        self.fails('console_extra_command')

    def test_privileged_exec_flag_refused(self):
        self.bus.services[M.CONSOLE]['ExecStartEx'][0][2] = ['privileged']
        self.fails('console_exec_mismatch')

    def test_source_parameter_in_cached_exec_refused(self):
        self.bus.services[M.CONSOLE]['ExecStart'][0][1][-3] = 'wrong'
        self.fails('console_exec_mismatch')

    def test_dotenv_and_root_directory_injection_refused(self):
        for key, value in [('EnvironmentFiles', [['/tmp/evil', False]]), ('RootDirectory', '/tmp/newroot')]:
            with self.subTest(key=key):
                old = self.bus.services[M.CONSOLE][key]
                self.bus.services[M.CONSOLE][key] = value
                self.fails('console_cache_mismatch')
                self.bus.services[M.CONSOLE][key] = old

    def test_wrong_bool_type_cannot_match_integer_setting(self):
        self.bus.services[M.CONSOLE]['LimitCORE'] = False
        self.fails('console_cache_mismatch')

    def test_stopped_with_control_process_refused(self):
        self.bus.services[M.CONSOLE]['ControlPID'] = 123
        self.fails('console_must_be_stopped')

    def test_database_oneshot_without_process_is_expected(self):
        self.manager.inspect_start_graph(**ARGS)
        self.bus.services[M.DATABASE]['RemainAfterExit'] = False
        self.fails('database_unit_not_ready')

    def test_graph_change_during_observation_refused(self):
        def mutate(name, interface, bus):
            if name == 'dbus.socket' and bus.reads[(name, interface)] == 2:
                bus.units[name]['Wants'] = ['new.service']
        self.bus.mutate = mutate
        self.fails('activation_graph_changed')

    def test_failed_terminal_can_be_observed_without_start(self):
        self.bus.units[M.CONSOLE].update({'ActiveState': 'failed', 'SubState': 'failed'})
        self.manager.inspect_graph(expect_console='terminal', **ARGS)
        self.fails('console_must_be_stopped')

    def test_auto_restart_is_not_terminal(self):
        self.bus.units[M.CONSOLE].update({'ActiveState': 'activating', 'SubState': 'auto-restart'})
        self.fails('console_must_be_stopped', lambda: self.manager.inspect_graph(expect_console='terminal', **ARGS))

    def test_running_projection_preserves_contract(self):
        before = self.manager.inspect_start_graph(**ARGS)
        self.bus.units[M.CONSOLE].update({'ActiveState': 'active', 'SubState': 'running', 'InvocationID': [3]*16})
        self.bus.services[M.CONSOLE].update({'MainPID': 4321, 'ControlGroup': '/app.slice/'+M.CONSOLE})
        after = self.manager.inspect_graph(expect_console='running', **ARGS)
        self.assertEqual(before['contract'], after['contract'])
        self.assertNotEqual(before['observation'][M.CONSOLE], after['observation'][M.CONSOLE])

    def test_start_uses_exact_owner_and_returns_actual_job(self):
        self.assertEqual(self.manager.start_console(), '/org/freedesktop/systemd1/job/123')
        calls = [c for c in self.bus.calls if c[3] == 'StartUnit']
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:6], (':1.4', M.MANAGER_PATH, M.MANAGER, 'StartUnit', 'ss', (M.CONSOLE, 'fail')))
        self.fails('activation_start_already_sent', self.manager.start_console)

    def test_lost_ack_is_uncertain_and_cannot_retry(self):
        self.bus.start_failure = 'org.freedesktop.DBus.Error.NoReply'
        self.fails('activation_dispatch_uncertain', self.manager.start_console)
        self.fails('activation_start_already_sent', self.manager.start_console)
        self.assertEqual(sum(c[3] == 'StartUnit' for c in self.bus.calls), 1)

    def test_every_message_disables_activation_and_interactive_authorization(self):
        self.manager.inspect_start_graph(**ARGS)
        self.manager.start_console()
        self.assertTrue(self.bus.messages)
        self.assertTrue(all(m.auto_start is False and m.interactive is False for m in self.bus.messages))

    def test_wrong_sender_serial_or_signature_is_not_start_ack(self):
        for key, value in [('sender', ':1.999'), ('serial', 0), ('signature', 's')]:
            with self.subTest(key=key):
                self.manager._start_sent = False  # independent internal fault fixtures
                self.bus.reply_fault = lambda m, r: setattr(r, key, value) if m.method == 'StartUnit' else None
                self.fails('activation_dispatch_uncertain', self.manager.start_console)

    def test_malformed_start_reply_stays_uncertain(self):
        self.bus.start_result = '/some/other/object'
        self.fails('activation_dispatch_uncertain', self.manager.start_console)

    def test_no_generic_mutation_dispatch(self):
        self.fails('invalid_manager_action', lambda: self.manager('reload'))
        self.assertEqual(self.bus.calls, [])

    def test_disconnected_sender_fence_precedes_same_owner_probe(self):
        identity = self.manager.connection_identity()
        self.manager.fence_sender(identity, ':1.75')
        lookup = next(i for i, c in enumerate(self.bus.calls) if c[3] == 'GetNameOwner' and c[5] == (':1.75',))
        ping = next(i for i, c in enumerate(self.bus.calls) if c[3] == 'Ping')
        self.assertLess(lookup, ping)
        self.assertEqual(self.bus.calls[ping][0], identity['manager_owner'])
        self.assertEqual(self.bus.calls[ping][2], 'org.freedesktop.DBus.Peer')
        self.assertFalse(any(c[3] == 'StartUnit' for c in self.bus.calls))

    def test_present_sender_is_not_fenced(self):
        identity = self.manager.connection_identity()
        self.bus.old_sender_exists = True
        self.fails('activation_sender_still_connected', lambda: self.manager.fence_sender(identity, ':1.75'))
        self.assertFalse(any(c[3] == 'Ping' for c in self.bus.calls))

    def test_generic_lookup_failure_is_not_sender_disappearance(self):
        identity = self.manager.connection_identity()
        for error in ('org.freedesktop.DBus.Error.NoReply', 'org.freedesktop.DBus.Error.Disconnected'):
            with self.subTest(error=error):
                self.bus.lookup_failure = error
                self.fails('activation_sender_unverified', lambda: self.manager.fence_sender(identity, ':1.75'))
        self.assertFalse(any(c[3] == 'Ping' for c in self.bus.calls))

    def test_changed_identity_never_fences_or_retargets(self):
        identity = self.manager.connection_identity()
        self.bus.owner = ':1.999'
        self.fails('manager_identity_changed', lambda: self.manager.fence_sender(identity, ':1.75'))
        self.assertFalse(any(c[3] == 'Ping' for c in self.bus.calls))

    def test_changed_manager_process_refused(self):
        self.manager.connection_identity()
        self.manager._process_probe = lambda pid, uid: {'pid': pid, 'uid': uid, 'start_ticks': 200}
        self.fails('manager_process_changed', self.manager.start_console)
        self.assertFalse(any(c[3] == 'StartUnit' for c in self.bus.calls))

    def test_live_recovery_connection_cannot_fence_itself(self):
        identity = self.manager.connection_identity()
        self.fails('invalid_activation_sender', lambda: self.manager.fence_sender(identity, self.bus.sender))

    def test_literal_dollar_remains_escaped_in_cached_argv(self):
        result = M.expected_command(**{**ARGS, 'root': '/repo % $ HOME'})
        self.assertIn('/repo % $$ HOME/src/cli.mjs', result)

    def test_graph_size_is_bounded(self):
        for i in range(M.MAX_NODES):
            name = 'extra'+str(i)+'.target'
            self.bus.add(name)
            self.bus.units['basic.target']['Wants'].append(name)
        self.fails('activation_graph_limit')

    def test_value_limits_reject_recursive_large_and_untyped_values(self):
        for value in [object(), 'x'*16385, float('nan'), [[[[[[[[[[[[]]]]]]]]]]]]]:
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(M.ActivateManagerError):
                    M.plain(value)


if __name__ == '__main__':
    unittest.main()
