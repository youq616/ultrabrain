"""Bound one console activation to systemd 255's cached execution/dependency contract.

The bus connection lives in this process; no mutation subprocess can outlive it.
Only start_console() mutates the manager. Graph checks describe the selected
cached properties, not every systemd setting or an isolation boundary against
another same-UID operator. The caller owns the deployment lock and journal.
"""
from __future__ import annotations
import importlib.util
import os
from pathlib import Path
import re
import time

CONSOLE = 'ultrabrain-personal-console.service'
DATABASE = 'ultrabrain-postgres.service'
TARGET = 'ultrabrain-personal.target'
WORKER = 'ultrabrain-personal-worker.service'
PERSONAL = (TARGET, CONSOLE, WORKER)
MANAGER = 'org.freedesktop.systemd1.Manager'
UNIT = 'org.freedesktop.systemd1.Unit'
SERVICE = 'org.freedesktop.systemd1.Service'
PROPERTIES = 'org.freedesktop.DBus.Properties'
BUS = 'org.freedesktop.DBus'
BUS_PATH = '/org/freedesktop/DBus'
MANAGER_PATH = '/org/freedesktop/systemd1'
BASE = ('Id', 'Names', 'LoadState', 'ActiveState', 'SubState', 'FragmentPath',
        'DropInPaths', 'NeedDaemonReload', 'Job')
DETAIL = (*BASE, 'MainPID', 'InvocationID', 'ControlGroup')
START_EDGES = ('Requires', 'Wants', 'BindsTo', 'Upholds')
STOP_EDGES = ('RequiredBy', 'RequisiteOf', 'BoundBy', 'ConsistsOf', 'PropagatesStopTo')
EDGES = (*START_EDGES, *STOP_EDGES, 'Requisite', 'PartOf', 'WantedBy', 'UpheldBy',
         'Conflicts', 'ConflictedBy', 'Before', 'After', 'OnFailure', 'OnSuccess',
         'Triggers', 'TriggeredBy', 'PropagatesReloadTo', 'ReloadPropagatedFrom',
         'StopPropagatedFrom')
UNIT_CACHE = ('Id', 'Names', 'LoadState', 'FragmentPath', 'DropInPaths',
              'NeedDaemonReload', 'Following', 'StopWhenUnneeded', 'RefuseManualStart',
              'RefuseManualStop', 'DefaultDependencies', 'FailureAction', 'SuccessAction',
              'StartLimitAction', 'JobTimeoutAction', 'JobTimeoutUSec', 'JobRunningTimeoutUSec',
              'StartLimitIntervalUSec', 'StartLimitBurst', *EDGES)
UNIT_RUNTIME = ('ActiveState', 'SubState', 'Job', 'InvocationID')
EXEC_LISTS = ('ExecCondition', 'ExecStartPre', 'ExecStart', 'ExecStartPost',
              'ExecReload', 'ExecStop', 'ExecStopPost')
SERVICE_VALUES = {
    'Type': 'exec', 'Restart': 'on-failure', 'RestartMode': 'normal',
    'RestartUSec': 30_000_000, 'RestartSteps': 0, 'RemainAfterExit': False,
    'Slice': 'app.slice',
    'TimeoutStopUSec': 90_000_000, 'TimeoutStartFailureMode': 'terminate',
    'TimeoutStopFailureMode': 'terminate', 'KillMode': 'control-group',
    'WorkingDirectory': '/', 'UMask': 0o077, 'NoNewPrivileges': True,
    'RestrictSUIDSGID': True, 'StandardInput': 'null', 'StandardOutput': 'journal',
    'StandardError': 'journal', 'LimitCORE': 0, 'LimitCORESoft': 0,
    'Environment': [], 'EnvironmentFiles': [], 'PassEnvironment': [], 'UnsetEnvironment': [],
    'User': '', 'Group': '', 'DynamicUser': False, 'RootDirectory': '', 'RootImage': '',
    'PAMName': '', 'SupplementaryGroups': [], 'PrivateUsers': False, 'RootDirectoryStartOnly': False,
    'RestartPreventExitStatus': [[], []], 'RestartForceExitStatus': [[], []],
}
SERVICE_RUNTIME = ('MainPID', 'ControlPID', 'ControlGroup', 'NRestarts')
MAX_NODES = 64
MAX_EDGES = 2048
MAX_VALUE_CELLS = 32768
MAX_VALUE_BYTES = 262144
UNIQUE = re.compile(r':[0-9]+\.[0-9]+')
UNIT_NAME = re.compile(r'[A-Za-z0-9_.:@\\-]{1,255}\.(?:service|target|socket|path|timer|slice|mount|automount|scope|device)')
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')


class ActivateManagerError(Exception):
    pass


def need(value, code):
    if not value:
        raise ActivateManagerError(code)


def plain(value, *, _budget=None, _depth=0):
    """Copy bounded D-Bus values to JSON types without logging received values."""
    budget = [0, 0] if _budget is None else _budget
    budget[0] += 1
    need(_depth <= 10 and budget[0] <= MAX_VALUE_CELLS, 'manager_value_limit')
    if value is None:
        return None
    # dbus.Boolean is an int subclass, so preserve its boolean type first.
    if type(value) is bool or (type(value).__name__ == 'Boolean'
                              and type(value).__module__.startswith('dbus')):
        return bool(value)
    if isinstance(value, str):
        budget[1] += len(value.encode('utf-8'))
        need(len(value) <= 16384 and budget[1] <= MAX_VALUE_BYTES
             and '\0' not in value, 'manager_value_limit')
        return str(value)
    if isinstance(value, int):
        need(-(2**63) <= value < 2**64, 'invalid_manager_value')
        return int(value)
    if isinstance(value, (list, tuple, bytes)):
        need(len(value) <= MAX_VALUE_CELLS, 'manager_value_limit')
        return [plain(v, _budget=budget, _depth=_depth+1) for v in value]
    if isinstance(value, dict):
        need(len(value) <= 2048, 'manager_value_limit')
        result = {}
        for key, item in value.items():
            key = plain(key, _budget=budget, _depth=_depth+1)
            need(type(key) is str and key not in result, 'invalid_manager_value')
            result[key] = plain(item, _budget=budget, _depth=_depth+1)
        return result
    raise ActivateManagerError('invalid_manager_value')


def absolute(value):
    value = str(value)
    need(value.startswith('/') and value != '/' and len(value.encode()) <= 4096
         and all(p not in ('', '.', '..') for p in value.split('/')[1:])
         and not any(ord(c) < 32 or ord(c) == 127 for c in value), 'invalid_absolute_path')
    return value


def expected_command(*, root, home, bun, source, port):
    root, home, bun = map(absolute, (root, home, bun))
    need(type(source) is str and re.fullmatch('[a-z0-9-]{1,32}', source)
         and type(port) is int and 1024 <= port <= 65535, 'invalid_activation_arguments')
    argv = ['/usr/bin/env', '-u', 'DATABASE_URL', '-u', 'GBRAIN_DATABASE_URL',
            '-u', 'NODE_OPTIONS', '-u', 'BUN_OPTIONS', '-u', 'PYTHONPATH', '-u', 'PYTHONHOME',
            '--', 'ULTRABRAIN_HOME='+home, 'GBRAIN_SOURCE='+source,
            'GBRAIN_HOME='+home+'/gbrain', 'GBRAIN_SWEEP=0', 'GBRAIN_SELF_UPGRADE_MODE=off',
            'ULTRABRAIN_MCP_PROFILE=compatibility', 'ULTRABRAIN_DEBUG=0',
            bun, '--no-env-file', root+'/src/cli.mjs', 'personal-ui', '--source', source,
            '--port', str(port)]
    # The v255 unit parser expands %% but leaves $$ for execution-time variable
    # expansion. Match its stored argv, not systemctl's presentation text.
    return [arg.replace('$', '$$') for arg in argv]


def select(value, keys):
    need(type(value) is dict and all(k in value for k in keys), 'manager_property_missing')
    return {k: value[k] for k in keys}


def names(value):
    need(type(value) is list and len(value) <= 512
         and all(type(n) is str and UNIT_NAME.fullmatch(n) for n in value)
         and len(value) == len(set(value)), 'invalid_manager_dependencies')
    return sorted(value)


def no_job(value):
    return (type(value) is list and len(value) == 2 and type(value[0]) is int
            and value[0] == 0 and value[1] == '/')


def manager_process(pid, uid):
    """Reuse the existing bounded procfs verifier; never read process environ."""
    need(type(pid) is int and 1 < pid <= 2147483647, 'invalid_manager_pid')
    try:
        spec = importlib.util.spec_from_file_location('activate_manager_process',
            Path(__file__).with_name('personal_ready_process.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        executable = os.readlink('/proc/'+str(pid)+'/exe')
        need(Path(executable).name == 'systemd', 'unexpected_manager_executable')
        return module._process_snapshot(pid, executable=executable, uid=uid)
    except ActivateManagerError:
        raise
    except Exception:
        raise ActivateManagerError('manager_process_unverified') from None


class LocalManager:
    """One direct, fixed-address connection; fixtures may inject an internal bus."""
    def __init__(self, *, deadline=None, _connection=None, _uid=None, _boot_id=None,
                 _process_probe=None, _message_factory=None):
        self.deadline = deadline if deadline is not None else time.monotonic()+30
        self.uid = os.geteuid() if _uid is None else _uid
        self.unit_paths = None
        self.console = None
        self.closed = False
        self._start_sent = False
        self._identity = None
        self._connecting = False
        self._provided_connection, self._provided_boot = _connection, _boot_id
        self._sender_name = None
        self._process_probe = _process_probe or manager_process
        self._manager_process = None
        self._message_factory = _message_factory

    @property
    def sender_name(self):
        self._connect()
        return self._sender_name

    def _connect(self):
        self._timeout()
        if self._identity is not None or self._connecting:
            return
        need(type(self.uid) is int and self.uid > 0
             and (self._provided_connection is not None or os.getuid() == self.uid),
             'ordinary_linux_account_required')
        self._connecting = True
        try:
            if self._provided_connection is None:
                import dbus
                from dbus.lowlevel import MethodCallMessage
                self._message_factory = MethodCallMessage
                self.connection = dbus.bus.BusConnection('unix:path=/run/user/'+str(self.uid)+'/bus')
            else:
                self.connection = self._provided_connection
                need(self._message_factory is not None, 'invalid_internal_manager_fixture')
            self.connection.set_exit_on_disconnect(False)
            self._sender_name = str(self.connection.get_unique_name())
            need(UNIQUE.fullmatch(self._sender_name), 'invalid_bus_identity')
            boot = (self._provided_boot if self._provided_boot is not None else
                    Path('/proc/sys/kernel/random/boot_id').read_text(encoding='ascii').strip())
            need(type(boot) is str and UUID.fullmatch(boot), 'invalid_boot_identity')
            bus_id = self._bus('GetId', '', ())
            owner = self._bus('GetNameOwner', 's', ('org.freedesktop.systemd1',))
            need(type(bus_id) is str and re.fullmatch('[a-f0-9]{32}', bus_id)
                 and type(owner) is str and UNIQUE.fullmatch(owner), 'invalid_bus_identity')
            self._identity = {'boot_id': boot, 'bus_id': bus_id, 'manager_owner': owner}
            peer_uid = self._bus('GetConnectionUnixUser', 's', (owner,))
            need(type(peer_uid) is int and peer_uid == self.uid, 'manager_owner_uid_mismatch')
            self.manager_pid = self._bus('GetConnectionUnixProcessID', 's', (owner,))
            self._manager_process = self._process_probe(self.manager_pid, self.uid)
            self.manager_version = self._property(MANAGER_PATH, MANAGER, 'Version')
            need(type(self.manager_version) is str
                 and re.match(r'^255(?:[.\s-]|$)', self.manager_version), 'unsupported_manager_version')
            self.connection_identity()
        except ActivateManagerError:
            self.close()
            raise
        except Exception:
            self.close()
            raise ActivateManagerError('manager_unavailable') from None
        finally:
            self._connecting = False

    def _timeout(self):
        need(not self.closed, 'manager_connection_closed')
        left = self.deadline - time.monotonic()
        need(left > 0, 'manager_timeout')
        return min(5.0, left)

    def _call(self, destination, path, interface, method, signature, args):
        if not self._connecting:
            self._connect()
        timeout = self._timeout()
        try:
            return plain(self._raw_call(destination, path, interface, method, signature, args, timeout))
        except ActivateManagerError:
            raise
        except Exception:
            raise ActivateManagerError('manager_unavailable') from None

    def _raw_call(self, destination, path, interface, method, signature, args, timeout):
        message = self._message_factory(destination, path, interface, method)
        message.set_auto_start(False)
        message.set_allow_interactive_authorization(False)
        message.append(*args, signature=signature)
        reply = self.connection.send_message_with_reply_and_block(message, timeout_s=timeout)
        expected = {'GetId': 's', 'GetNameOwner': 's', 'GetConnectionUnixUser': 'u',
                    'GetConnectionUnixProcessID': 'u', 'LoadUnit': 'o', 'StartUnit': 'o',
                    'Get': 'v', 'GetAll': 'a{sv}', 'Ping': ''}[method]
        need(reply.get_sender() == destination and str(reply.get_signature()) == expected
             and message.get_serial() > 0 and reply.get_reply_serial() == message.get_serial(),
             'invalid_manager_reply')
        values = reply.get_args_list()
        need(len(values) == (0 if expected == '' else 1), 'invalid_manager_reply')
        return values[0] if values else None

    def _bus(self, method, signature, args):
        return self._call(BUS, BUS_PATH, BUS, method, signature, args)

    def _manager(self, method, signature, args):
        self._connect()
        return self._call(self._identity['manager_owner'], MANAGER_PATH, MANAGER,
                          method, signature, args)

    def _property(self, path, interface, name):
        self._connect()
        return self._call(self._identity['manager_owner'], path, PROPERTIES, 'Get',
                          'ss', (interface, name))

    def connection_identity(self):
        self._connect()
        need(self._identity is not None, 'invalid_bus_identity')
        need(self._bus('GetId', '', ()) == self._identity['bus_id']
             and self._bus('GetNameOwner', 's', ('org.freedesktop.systemd1',))
             == self._identity['manager_owner'], 'manager_identity_changed')
        need(self._bus('GetConnectionUnixUser', 's', (self._identity['manager_owner'],)) == self.uid
             and self._bus('GetConnectionUnixProcessID', 's', (self._identity['manager_owner'],))
             == self.manager_pid and self._process_probe(self.manager_pid, self.uid) == self._manager_process,
             'manager_process_changed')
        return dict(self._identity)

    def verify_identity(self, saved_identity):
        need(type(saved_identity) is dict
             and set(saved_identity) == {'boot_id', 'bus_id', 'manager_owner'},
             'invalid_saved_manager_identity')
        need(self.connection_identity() == saved_identity, 'manager_identity_changed')
        return dict(self._identity)

    def fence_sender(self, saved_identity, old_sender):
        """Prove an old v255 same-UID sender is gone, then cross its owner barrier.

        The caller must hold the exclusive global deployment lock. No successful
        lookup, generic failure or changed bus/manager can establish this fence.
        StartUnit's same-UID authorization is synchronous in the supported v255
        manager; this is not a fence for privileged or deferred polkit requests.
        """
        self.verify_identity(saved_identity)
        need(type(old_sender) is str and len(old_sender) <= 128 and UNIQUE.fullmatch(old_sender)
             and old_sender != self.sender_name, 'invalid_activation_sender')
        try:
            self._raw_call(BUS, BUS_PATH, BUS, 'GetNameOwner', 's', (old_sender,), self._timeout())
        except Exception as error:
            name = getattr(error, 'get_dbus_name', lambda: '')()
            need(name == 'org.freedesktop.DBus.Error.NameHasNoOwner', 'activation_sender_unverified')
        else:
            raise ActivateManagerError('activation_sender_still_connected')
        result = self._call(saved_identity['manager_owner'], MANAGER_PATH,
                            'org.freedesktop.DBus.Peer', 'Ping', '', ())
        need(result is None, 'invalid_manager_barrier')
        self.verify_identity(saved_identity)
        return dict(self._identity)

    def close(self):
        if not getattr(self, 'closed', True):
            self.closed = True
            try:
                if hasattr(self, 'connection'):
                    self.connection.close()
            except Exception:
                pass

    def _all(self, path, interface):
        return self._call(self._identity['manager_owner'], path, PROPERTIES, 'GetAll',
                          's', (interface,))

    def _load(self, name):
        need(type(name) is str and UNIT_NAME.fullmatch(name), 'invalid_unit_name')
        path = self._manager('LoadUnit', 's', (name,))
        need(type(path) is str and re.fullmatch(r'/org/freedesktop/systemd1/unit/[A-Za-z0-9_]+', path),
             'invalid_unit_object')
        return path

    def _read(self, name, *, full=False):
        path = self._load(name)
        raw = self._all(path, UNIT)
        keys = (*UNIT_CACHE, *UNIT_RUNTIME) if full else BASE
        unit = select(raw, keys)
        need(unit['Id'] == name and name in names(unit['Names']), 'unit_alias_refused')
        for key in ('Id', 'LoadState', 'ActiveState', 'SubState', 'FragmentPath'):
            need(type(unit[key]) is str, 'invalid_manager_response')
        need(type(unit['DropInPaths']) is list and all(type(p) is str for p in unit['DropInPaths'])
             and type(unit['NeedDaemonReload']) is bool, 'invalid_manager_response')
        if full:
            for key in EDGES:
                unit[key] = names(unit[key])
            unit['Names'] = names(unit['Names'])
            for key in ('Following', 'FailureAction', 'SuccessAction', 'StartLimitAction', 'JobTimeoutAction'):
                need(type(unit[key]) is str, 'invalid_manager_response')
            for key in ('StopWhenUnneeded', 'RefuseManualStart', 'RefuseManualStop', 'DefaultDependencies'):
                need(type(unit[key]) is bool, 'invalid_manager_response')
        service = None
        if name.endswith('.service') and unit['LoadState'] == 'loaded':
            all_service = self._all(path, SERVICE)
            service = select(all_service, SERVICE_RUNTIME)
            need(all(type(service[k]) is int and service[k] >= 0
                     for k in ('MainPID', 'ControlPID', 'NRestarts'))
                 and type(service['ControlGroup']) is str, 'invalid_manager_response')
            if name == CONSOLE and full:
                service.update(select(all_service, (*SERVICE_VALUES, *EXEC_LISTS,
                                                    *(n+'Ex' for n in EXEC_LISTS))))
            if name == DATABASE and full:
                service.update(select(all_service, ('Type', 'RemainAfterExit')))
        return unit, service

    def _paths(self):
        paths = self._property(MANAGER_PATH, MANAGER, 'UnitPath')
        need(type(paths) is list and 0 < len(paths) <= 128, 'unsupported_manager_unit_paths')
        self.unit_paths = tuple(Path(absolute(p)) for p in paths)
        need(len(self.unit_paths) == len(set(self.unit_paths)), 'unsupported_manager_unit_paths')
        return [str(p) for p in self.unit_paths]

    @staticmethod
    def _row(unit):
        need(type(unit['Job']) is list and len(unit['Job']) == 2 and type(unit['Job'][0]) is int,
             'invalid_manager_response')
        return {k: (' '.join(unit[k]) if k in ('Names', 'DropInPaths') else
                    ('yes' if unit[k] else 'no') if k == 'NeedDaemonReload' else
                    str(unit[k][0]) if k == 'Job' else unit[k]) for k in BASE}

    def __call__(self, action):
        need(action == 'show', 'invalid_manager_action')
        self.connection_identity()
        self._paths()
        rows = {}
        for name in PERSONAL:
            unit, service = self._read(name)
            rows[name] = self._row(unit)
            if name == CONSOLE:
                need(service is not None, 'console_unit_unavailable')
                invocation = self._property(self._load(name), UNIT, 'InvocationID')
                self.console = {**rows[name], 'MainPID': str(service['MainPID']),
                                'InvocationID': self._invocation(invocation),
                                'ControlGroup': service['ControlGroup']}
        self.connection_identity()
        return rows

    @staticmethod
    def _invocation(value):
        need(type(value) is list and len(value) in (0, 16)
             and all(type(n) is int and 0 <= n <= 255 for n in value), 'invalid_console_invocation')
        return bytes(value).hex()

    def inspect_start_graph(self, **arguments):
        return self.inspect_graph(expect_console='stopped', **arguments)

    def inspect_graph(self, *, root, home, bun, source, port, expect_console='stopped',
                      console_unit=CONSOLE, database_unit=DATABASE):
        need(console_unit == CONSOLE and database_unit == DATABASE
             and expect_console in ('stopped', 'running', 'terminal'), 'invalid_activation_arguments')
        argv = expected_command(root=root, home=home, bun=bun, source=source, port=port)
        identity = self.connection_identity()
        paths = self._paths()
        observed, starts, stops, verify = {}, {CONSOLE}, set(), set()
        pending = [('start', CONSOLE)]
        processed = set()
        edge_count = 0

        def read(name):
            if name not in observed:
                need(len(observed) < MAX_NODES, 'activation_graph_limit')
                # v255 device.c's canonical sys-* device has Following="" but
                # following_set() still adds sibling devices to a transaction.
                # This bounded graph does not certify that hidden inventory.
                # Swap units are already excluded by UNIT_NAME as well.
                need(not name.endswith(('.device', '.swap')), 'unsupported_activation_unit')
                need(not name.startswith('ultrabrain-') or name in (CONSOLE, DATABASE),
                     'unexpected_activation_unit')
                unit, service = self._read(name, full=True)
                need(unit['LoadState'] == 'loaded' and not unit['NeedDaemonReload']
                     and unit['Following'] == '' and no_job(unit['Job']), 'activation_unit_not_stable')
                need(not unit['StopWhenUnneeded'], 'dependency_stop_when_unneeded')
                observed[name] = (unit, service)
            return observed[name]

        while pending:
            mode, name = pending.pop()
            if (mode, name) in processed:
                continue
            processed.add((mode, name))
            unit, _ = read(name)
            edges = []
            if mode == 'start':
                for key in START_EDGES:
                    edges.extend(('start', n) for n in unit[key])
                for key in ('Conflicts', 'ConflictedBy'):
                    edges.extend(('stop', n) for n in unit[key])
                edges.extend(('verify', n) for n in unit['Requisite'])
            elif mode == 'stop':
                for key in STOP_EDGES:
                    edges.extend(('stop', n) for n in unit[key])
            edge_count += len(edges)
            need(edge_count <= MAX_EDGES, 'activation_graph_limit')
            for kind, other in edges:
                {'start': starts, 'stop': stops, 'verify': verify}[kind].add(other)
                pending.append((kind, other))

        need(DATABASE in starts and not starts & stops, 'invalid_activation_graph')
        contract, runtime = {}, {}
        for name in sorted(observed):
            unit, service = observed[name]
            if name == CONSOLE:
                self._console_guard(unit, service, argv, expect_console)
            else:
                need(unit['ActiveState'] == ('inactive' if name in stops else 'active'),
                     'activation_dependency_not_ready')
                need(unit['SubState'] not in ('auto-restart', 'reloading', 'start', 'stop'),
                     'activation_dependency_not_ready')
            if name == DATABASE:
                need(unit['Names'] == [DATABASE] and unit['SubState'] == 'exited'
                     and not unit['DropInPaths'] and service is not None
                     and service['Type'] == 'oneshot' and service['RemainAfterExit'] is True
                     and service['MainPID'] == service['ControlPID'] == 0,
                     'database_unit_not_ready')
            cache = select(unit, UNIT_CACHE)
            state = select(unit, UNIT_RUNTIME)
            state['InvocationID'] = self._invocation(state['InvocationID'])
            if service is not None:
                state.update(select(service, SERVICE_RUNTIME))
                if name == CONSOLE:
                    cache['service'] = {**select(service, SERVICE_VALUES),
                                        'ExecStart': ['/usr/bin/env', argv, []]}
                elif name == DATABASE:
                    cache['service'] = select(service, ('Type', 'RemainAfterExit'))
            contract[name], runtime[name] = cache, state
        # Close the graph read against observable changes. This is a maintenance
        # window check, not atomic exclusion of unrelated same-UID bus clients.
        for name, expected in observed.items():
            need(self._read(name, full=True) == expected, 'activation_graph_changed')
        need(self._paths() == paths and self.connection_identity() == identity, 'manager_identity_changed')
        return plain({'contract': {'format': 1, 'connection': identity, 'manager_version': self.manager_version,
                             'manager_process': self._manager_process,
                             'unit_paths': paths, 'start_units': sorted(starts), 'stop_units': sorted(stops),
                             'verify_units': sorted(verify), 'units': contract},
                'observation': runtime})

    @staticmethod
    def _console_guard(unit, service, argv, expected):
        need(unit['Names'] == [CONSOLE] and not unit['DropInPaths'] and service is not None,
             'console_cache_mismatch')
        for name in (*STOP_EDGES, 'Upholds', 'UpheldBy', 'OnFailure', 'OnSuccess', 'Triggers', 'TriggeredBy'):
            need(unit[name] == [], 'console_dependency_side_effect')
        need(not unit['RefuseManualStart'] and not unit['RefuseManualStop']
             and unit['DefaultDependencies'] is True
             and all(unit[k] == 'none' for k in ('FailureAction', 'SuccessAction', 'StartLimitAction', 'JobTimeoutAction'))
             and unit['JobTimeoutUSec'] == unit['JobRunningTimeoutUSec'] == 2**64-1
             and unit['StartLimitIntervalUSec'] == 300_000_000 and unit['StartLimitBurst'] == 3,
             'console_cache_mismatch')
        need(unit['Requires'] == sorted([DATABASE, 'basic.target', 'app.slice']) and unit['Wants'] == []
             and unit['BindsTo'] == [] and unit['Requisite'] == []
             and unit['PartOf'] == sorted([DATABASE, TARGET]), 'console_dependency_mismatch')
        for key, value in SERVICE_VALUES.items():
            need(type(service[key]) is type(value) and service[key] == value, 'console_cache_mismatch')
        for name in EXEC_LISTS:
            rows, extended = service[name], service[name+'Ex']
            if name != 'ExecStart':
                need(rows == extended == [], 'console_extra_command')
                continue
            need(type(rows) is list and type(extended) is list and len(rows) == len(extended) == 1,
                 'console_exec_mismatch')
            row, ex = rows[0], extended[0]
            need(type(row) is list and type(ex) is list and len(row) == len(ex) == 10
                 and row[:2] == ex[:2] == ['/usr/bin/env', argv]
                 and row[2] is False and ex[2] == []
                 and all(type(n) is int for n in (*row[3:], *ex[3:])), 'console_exec_mismatch')
        if expected == 'running':
            need(unit['ActiveState'] == 'active' and unit['SubState'] == 'running'
                 and service['MainPID'] > 0 and service['ControlPID'] == 0, 'console_not_running')
        else:
            terminal = (unit['ActiveState'], unit['SubState'])
            allowed = {('inactive', 'dead')}
            if expected == 'terminal':
                allowed.add(('failed', 'failed'))
            need(terminal in allowed and service['MainPID'] == service['ControlPID'] == 0,
                 'console_must_be_stopped')

    def start_console(self):
        """Send one request only. Any post-dispatch failure is an unknown result."""
        need(not self._start_sent, 'activation_start_already_sent')
        self.connection_identity()
        timeout = self._timeout()
        self._start_sent = True
        try:
            result = plain(self._raw_call(
                self._identity['manager_owner'], MANAGER_PATH, MANAGER, 'StartUnit',
                'ss', (CONSOLE, 'fail'), timeout))
            need(type(result) is str and re.fullmatch(r'/org/freedesktop/systemd1/job/[1-9][0-9]*', result),
                 'activation_dispatch_uncertain')
            return result
        except Exception:
            raise ActivateManagerError('activation_dispatch_uncertain') from None
