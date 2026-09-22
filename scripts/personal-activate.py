#!/usr/bin/env python3
"""Explicitly activate an installed console; recover by observation, never stop.

The ordinary service account's existing deployment lock and reservation slot
serialize installation and activation. A private D-Bus connection sends one
StartUnit to a verified user manager; recovery fences its departed sender before
observing the result. No shell, mutation subprocess, retry, enablement or reload.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import time


def sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


READY = sibling('activate_readiness', 'personal-ready.py')
MANAGER = sibling('activate_manager', 'personal_activate_manager.py')
IDENTITY = sibling('activate_identity', 'personal-identity.py')
DEPLOY, FS, SERVICES, PREFLIGHT = READY.DEPLOY, READY.FS, READY.SERVICES, READY.PREFLIGHT
ActivateError, need = FS.DeployError, FS.need
ROOT = Path(__file__).resolve().parents[1]
NO_OTHER_ACTIONS = {'configuration_changed': False, 'services_stopped': False,
                    'enablement_changed': False, 'model_called': False,
                    'automatic_stop_authorized': False}
SENDER = re.compile(r':[0-9]{1,20}\.[0-9]{1,20}')


class Context(READY.Context):
    def __init__(self, home, *, user_home=None, manager=None, processes=None,
                 transport=None, root=None, fault=None):
        super().__init__(home, user_home=user_home, manager=manager or MANAGER.LocalManager(),
                         processes=processes, transport=transport, root=root)
        self.activation = self.home/'personal-activation'
        self.authorized_pending = None
        self.fault = fault or (lambda _label: None)
        self.deadline = None

    @contextmanager
    def _held(self, exclusive=False):
        # Unlike first installation, activation must never create a missing lock.
        self.store.read(self.shared/'lock', limit=0)
        with self._lock(exclusive=exclusive):
            try:
                need(self.lock_identity is not None, 'deployment_lock_missing')
                yield
            finally:
                # A later holder must not mistake a still-connected old sender
                # for a completed activation process. SIGKILL closes both FDs.
                self.manager.close()

    def _reservation(self):
        local, _ = self.store.read_json(self.state/'pending.json', limit=65536, optional=True)
        need(local is None, 'deployment_pending')
        value, _ = self.store.read_json(self.shared/'pending.json', limit=65536, optional=True)
        if value is None:
            return None
        need(value.get('home') == str(self.home) and value.get('user_home') == str(self.user_home),
             'other_deployment_pending')
        need(value.get('operation') == 'activate', 'deployment_pending')
        need(set(value) == {'format', 'operation', 'home', 'user_home', 'operation_sha256'}
             and type(value['format']) is int and value['format'] == 2,
             'invalid_activation_reservation')
        FS.sha(value['operation_sha256'])
        return value

    def _pending(self):
        # Internal readiness may observe only this exact held activation. Public
        # ready/deploy and older deployers all reject the same shared reservation.
        value = self._reservation()
        if value is not None:
            self._lock_check()
            need(self.lock_identity is not None and value['operation_sha256'] == self.authorized_pending,
                 'activation_pending')
        return None

    def _arguments(self, *, bun, source, port, expected_current, expected_instance):
        bun = str(FS.absolute(bun))
        FS.sha(expected_current)
        need(isinstance(expected_instance, str) and READY.UUID.fullmatch(expected_instance)
             and expected_instance != '00000000-0000-0000-0000-000000000000', 'invalid_expected_instance')
        plan = SERVICES.plan(str(self.root), str(self.home), bun, source=source, port=port)
        return {'bun': bun, 'source': source, 'port': port, 'expected_current': expected_current,
                'expected_instance': expected_instance}, plan

    def _installation(self, plan, expected):
        self._lock_check()
        self._pending()
        current, identity = self._current()
        need(current == expected, 'current_deployment_mismatch')
        receipt = self._receipt(current)
        need(receipt is not None and receipt['plan'] == plan, 'installed_plan_mismatch')
        links, targets = self._links(), self._targets(receipt)
        need(all((links[n]['target'] if links[n] else None) == targets[n]
                 for n in DEPLOY.PERSONAL_UNITS), 'installed_units_changed')
        self._check_paths()
        generation = self.state/'generations'/plan['plan_sha256']
        return {'current': current, 'current_identity': identity, 'links': links,
                'directories': {**self._directories(), 'shared': self._directory_id(self.shared)},
                'generation_identity': self._directory_id(generation),
                'generation_files': {n: self.store.read(generation/n)[1]
                                     for n in (*plan['units'], 'manifest.json')},
                'unit_paths': [str(p) for p in self.manager.unit_paths]}

    def _observe(self, args, plan, *, state):
        READY.remaining(self.deadline)
        self.manager.deadline = self.deadline
        rows = self.manager('show')
        receipt = self._receipt(args['expected_current'])
        targets = self._targets(receipt)
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
            if name != SERVICES.CONSOLE or state == 'stopped':
                need(row['ActiveState'] == 'inactive' and row['SubState'] in ('dead', 'inactive'),
                     'personal_units_must_be_stopped')
        installed = self._installation(plan, args['expected_current'])
        graph = self.manager.inspect_graph(root=str(self.root), home=str(self.home), bun=args['bun'],
                    source=args['source'], port=args['port'], expect_console=state)
        need(isinstance(graph, dict) and set(graph) == {'contract', 'observation'},
             'invalid_activation_graph')
        pins = PREFLIGHT.check_pins(self.root)
        with PREFLIGHT.PrivateHome(self.home) as view:
            database = self.processes.database_snapshot(view, pins)
            token = view.read('personal-console-token', limit=128)
            need(re.fullmatch(rb'[a-f0-9]{64}\n?', token), 'invalid_console_token')
            view.unchanged()
        need(installed == self._installation(plan, args['expected_current']),
             'installation_changed_during_check')
        identity = self.manager.connection_identity()
        READY.remaining(self.deadline)
        return {'installation': installed, 'database': database, 'pins': pins,
                'token_sha256': hashlib.sha256(token).hexdigest(),
                'connection': identity, 'graph': graph}

    def _plan(self, args, service_plan):
        need(self._reservation() is None, 'activation_pending')
        observation = self._observe(args, service_plan, state='stopped')
        body = {'format': 1, 'operation': 'start-console-stopped-v1', 'uid': self.uid,
                'home': str(self.home), 'user_home': str(self.user_home), 'root': str(self.root),
                'arguments': args, 'service_plan_sha256': service_plan['plan_sha256'],
                'observation': observation, 'starts': [SERVICES.CONSOLE],
                'database_requirement': 'already_active_managed_postmaster',
                'target_started': False, 'worker_authorized': False, **NO_OTHER_ACTIONS}
        return {**body, 'activation_plan_sha256': FS.digest(body)}

    def plan(self, **kwargs):
        args, service_plan = self._arguments(**kwargs)
        self.deadline = time.monotonic()+30
        with self._held():
            return self._plan(args, service_plan)

    def prepare(self, *, bun, source, port, expected_current):
        """Observe identity and prepare the existing plan, never dispatch a start.

        Hold the existing reader lock across both operations. Compare the whole
        stopped binding before/after identity SQL; an intervening restart, token
        replacement or deployment change cannot yield a usable prepared plan.
        This is not an API for replacing a caller's already trusted instance pin.
        """
        bun = str(FS.absolute(bun))
        FS.sha(expected_current)
        service_plan = SERVICES.plan(str(self.root), str(self.home), bun, source=source, port=port)
        options = {'bun': bun, 'source': source, 'port': port, 'expected_current': expected_current}
        self.deadline = time.monotonic()+30
        with self._held():
            need(self._reservation() is None, 'activation_pending')
            before = self._observe(options, service_plan, state='stopped')
            identity = IDENTITY.observe(str(self.home), source, root=self.root, deadline=self.deadline)
            need(isinstance(identity, dict) and type(identity.get('format')) is int
                 and identity['format'] == 1 and identity.get('ok') is True
                 and identity.get('source_id') == source and identity.get('identity_verified') is True
                 and identity.get('database_process_binding_verified') is True
                 and identity.get('transport') == 'private-unix-socket'
                 and identity.get('authentication') == 'os-peer-and-scram-sha-256',
                 'instance_identity_unverified')
            args, _ = self._arguments(**options, expected_instance=identity.get('instance_id'))
            plan = self._plan(args, service_plan)
            after = plan['observation']
            need(before['database'] == after['database'], 'database_changed_during_check')
            need(before == after, 'preparation_binding_changed')
            READY.remaining(self.deadline)
            return plan

    def _op_path(self, operation):
        return self.activation/'operations'/FS.sha(operation)

    def _once(self, path, value):
        if self.store.absent(path):
            self._atomic_new(path, FS.canonical(value))
        actual, _ = self.store.read_json(path)
        need(actual == value, 'activation_record_changed')

    def _intent(self, operation):
        value, _ = self.store.read_json(self._op_path(operation)/'intent.json')
        need(set(value) == {'format', 'nonce', 'plan', 'sender_name'} and type(value['format']) is int
             and value['format'] == 1 and FS.digest(value) == operation
             and isinstance(value['nonce'], str) and re.fullmatch('[a-f0-9]{32}', value['nonce'])
             and isinstance(value['sender_name'], str) and SENDER.fullmatch(value['sender_name']),
             'invalid_activation_intent')
        plan = value['plan']
        need(isinstance(plan, dict) and set(plan) == {'format', 'operation', 'uid', 'home',
             'user_home', 'root', 'arguments', 'service_plan_sha256', 'observation', 'starts',
             'database_requirement', 'target_started', 'worker_authorized',
             'activation_plan_sha256', *NO_OTHER_ACTIONS}
             and type(plan.get('format')) is int and plan['format'] == 1
             and plan.get('home') == str(self.home)
             and plan.get('user_home') == str(self.user_home) and plan.get('root') == str(self.root)
             and type(plan.get('uid')) is int and plan['uid'] == self.uid
             and plan.get('operation') == 'start-console-stopped-v1', 'invalid_activation_intent')
        need(plan['starts'] == [SERVICES.CONSOLE]
             and plan['database_requirement'] == 'already_active_managed_postmaster'
             and plan['target_started'] is False and plan['worker_authorized'] is False
             and all(plan[k] is False for k in NO_OTHER_ACTIONS), 'invalid_activation_intent')
        expected = plan.get('activation_plan_sha256')
        FS.sha(expected)
        need(FS.digest({k: v for k, v in plan.items() if k != 'activation_plan_sha256'}) == expected,
             'invalid_activation_intent')
        args = plan.get('arguments')
        need(isinstance(args, dict) and set(args) ==
             {'bun', 'source', 'port', 'expected_current', 'expected_instance'}, 'invalid_activation_intent')
        arguments, service_plan = self._arguments(**args)
        need(arguments == args and plan.get('service_plan_sha256') == service_plan['plan_sha256'],
             'invalid_activation_intent')
        need(isinstance(plan.get('observation'), dict) and set(plan['observation']) ==
             {'installation', 'database', 'pins', 'token_sha256', 'connection', 'graph'},
             'invalid_activation_intent')
        return value, args, service_plan

    def _records(self, operation):
        path = self._op_path(operation)
        attempt, _ = self.store.read_json(path/'attempt.json', limit=512, optional=True)
        ack, _ = self.store.read_json(path/'ack.json', limit=1024, optional=True)
        receipt, _ = self.store.read_json(path/'receipt.json', limit=16384, optional=True)
        if attempt is not None:
            need(attempt == {'format': 1, 'operation_sha256': operation}
                 and type(attempt['format']) is int, 'invalid_activation_attempt')
        if ack is not None:
            need(attempt is not None and set(ack) == {'format', 'operation_sha256', 'job_path'}
                 and type(ack['format']) is int and ack['format'] == 1
                 and ack['operation_sha256'] == operation and isinstance(ack['job_path'], str)
                 and re.fullmatch('/org/freedesktop/systemd1/job/[1-9][0-9]{0,19}', ack['job_path']),
                 'invalid_activation_acknowledgement')
        if receipt is not None:
            need(set(receipt) == {'format', 'operation_sha256', 'outcome', 'observed_at',
                 'dispatch_state', 'readiness', 'recovery_fenced'} and type(receipt['format']) is int
                 and receipt['format'] == 1 and receipt['operation_sha256'] == operation
                 and receipt['outcome'] in ('ready', 'not_running', 'not_dispatched')
                 and type(receipt['observed_at']) is int and receipt['observed_at'] > 0
                 and type(receipt['recovery_fenced']) is bool
                 and receipt['dispatch_state'] == self._dispatch(attempt, ack), 'invalid_activation_receipt')
            if receipt['outcome'] == 'ready':
                r = receipt['readiness']
                _, args, _ = self._intent(operation)
                need(isinstance(r, dict) and set(r) == {'format', 'application_ready',
                     'current_sha256', 'source_id', 'instance_id', 'console_pid', 'invocation_id',
                     'unit_binding_verified', 'database_process_binding_verified',
                     'expected_instance_verified', 'authenticated_console_ready',
                     'worker_readiness', 'socket_owner_verified', 'scope', *READY.NO_ACTIONS}
                     and type(r['format']) is int and r['format'] == 1
                     and r.get('application_ready') is True
                     and r['current_sha256'] == args['expected_current']
                     and r['source_id'] == args['source'] and r['instance_id'] == args['expected_instance']
                     and type(r['console_pid']) is int and 1 < r['console_pid'] <= 2147483647
                     and isinstance(r.get('invocation_id'), str)
                     and re.fullmatch('[a-f0-9]{32}', r['invocation_id'])
                     and r['invocation_id'] != '0'*32
                     and all(r[k] is True for k in ('unit_binding_verified', 'database_process_binding_verified',
                             'expected_instance_verified', 'authenticated_console_ready'))
                     and all(r[k] is False for k in READY.NO_ACTIONS)
                     and r['worker_readiness'] == 'not_checked' and r['socket_owner_verified'] is False
                     and isinstance(r['scope'], str) and len(r['scope']) <= 512
                     and (receipt['recovery_fenced'] or ack is not None), 'invalid_activation_receipt')
            else:
                need(receipt['readiness'] is None and receipt['recovery_fenced'] is True
                     and (receipt['outcome'] == 'not_dispatched') == (attempt is None),
                     'invalid_activation_receipt')
        return attempt, ack, receipt

    @staticmethod
    def _dispatch(attempt, ack):
        return 'acknowledged' if ack is not None else 'outcome_unknown' if attempt is not None else 'not_attempted'

    def _owned(self, operation):
        self._lock_check()
        value = self._reservation()
        need(value is not None and value['operation_sha256'] == operation, 'activation_reservation_changed')
        self._intent(operation)

    def _same(self, before, after):
        need(all(after[k] == before[k] for k in before if k != 'graph'), 'activation_binding_changed')
        need(after['graph']['contract'] == before['graph']['contract'], 'activation_contract_changed')
        old, new = before['graph']['observation'], after['graph']['observation']
        need(set(old) == set(new) and all(old[n] == new[n] for n in old if n != SERVICES.CONSOLE),
             'activation_dependency_changed')

    def _fresh_ready(self, args, service_plan, baseline):
        observed = self._observe(args, service_plan, state='running')
        self._same(baseline, observed)
        result = self._check_locked(**args, deadline=self.deadline)
        after = self._observe(args, service_plan, state='running')
        self._same(baseline, after)
        need(observed == after and self.manager.console['InvocationID'] == result['invocation_id']
             and int(self.manager.console['MainPID']) == result['console_pid'], 'activation_console_changed')
        return result

    def _last(self):
        value, _ = self.store.read_json(self.activation/'last.json', limit=1024, optional=True)
        if value is None:
            return None
        need(set(value) == {'format', 'operation_sha256', 'receipt_sha256'}
             and type(value['format']) is int and value['format'] == 1, 'invalid_activation_history')
        self._intent(FS.sha(value['operation_sha256']))
        receipt = self._records(value['operation_sha256'])[2]
        need(receipt is not None and FS.digest(receipt) == FS.sha(value['receipt_sha256']),
             'invalid_activation_history')
        return {**value, 'outcome': receipt['outcome'], 'observed_at': receipt['observed_at']}

    def _finish(self, operation, receipt, *, fresh=None, observed=False):
        self._owned(operation)
        self._once(self._op_path(operation)/'receipt.json', receipt)
        self.fault('after_receipt')
        self._owned(operation)
        value = {'format': 1, 'operation_sha256': operation, 'receipt_sha256': FS.digest(receipt)}
        existing, identity = self.store.read_json(self.activation/'last.json', limit=1024, optional=True)
        if existing is not None:
            self._last()
        if existing != value:
            staging = self.activation/('.incoming-'+secrets.token_hex(16))
            self.store.write_new(staging, FS.canonical(value))
            need(self.store.read_json(self.activation/'last.json', limit=1024, optional=True) == (existing, identity),
                 'activation_history_changed')
            self.store.replace(staging, self.activation/'last.json', absent_expected=existing is None)
        self.fault('before_clear_pending')
        self._owned(operation)
        need(self._records(operation)[2] == receipt, 'activation_record_changed')
        self.store.remove(self.shared/'pending.json')
        self.authorized_pending = None
        self.fault('after_clear_pending')
        return {'format': 1, 'operation_sha256': operation, 'receipt_sha256': FS.digest(receipt),
                'pending_sha256': None, 'activation_outcome': receipt['outcome'],
                'dispatch_state': receipt['dispatch_state'],
                'application_ready': True if fresh else False if observed else 'not_checked',
                'readiness': fresh, 'activation_state_changed': True, **NO_OTHER_ACTIONS}

    def _conclude(self, operation, outcome, *, readiness=None, fenced=False):
        attempt, ack, receipt = self._records(operation)
        need(receipt is None, 'activation_already_committed')
        receipt = {'format': 1, 'operation_sha256': operation, 'outcome': outcome,
                   'observed_at': int(time.time()), 'dispatch_state': self._dispatch(attempt, ack),
                   'readiness': readiness, 'recovery_fenced': fenced}
        return self._finish(operation, receipt, fresh=readiness, observed=True)

    def apply(self, *, expected_plan, **kwargs):
        FS.sha(expected_plan)
        args, service_plan = self._arguments(**kwargs)
        self.deadline = time.monotonic()+45
        with self._held(exclusive=True):
            planned = self._plan(args, service_plan)
            need(planned['activation_plan_sha256'] == expected_plan, 'activation_plan_mismatch')
            for path in (self.activation, self.activation/'operations'):
                self.store.mkdir(path)
            sender = self.manager.sender_name
            need(isinstance(sender, str) and SENDER.fullmatch(sender), 'invalid_activation_sender')
            intent = {'format': 1, 'nonce': secrets.token_hex(16), 'plan': planned, 'sender_name': sender}
            operation = FS.digest(intent)
            self.store.mkdir(self._op_path(operation), exclusive=True)
            self._once(self._op_path(operation)/'intent.json', intent)
            # The immutable intent exists before its sole shared reservation.
            # Unreferenced prepublication directories have no startup authority.
            self._once(self.shared/'pending.json', {'format': 2, 'operation': 'activate',
                       'home': str(self.home), 'user_home': str(self.user_home), 'operation_sha256': operation})
            self.authorized_pending = operation
            self.fault('after_journal')
            self._owned(operation)
            need(self._observe(args, service_plan, state='stopped') == planned['observation'],
                 'activation_plan_mismatch')
            self._once(self._op_path(operation)/'attempt.json', {'format': 1, 'operation_sha256': operation})
            self.fault('after_attempt')
            self._owned(operation)
            self.manager.verify_identity(planned['observation']['connection'])
            job = self.manager.start_console()
            self.fault('after_start_before_ack')
            self._once(self._op_path(operation)/'ack.json', {'format': 1, 'operation_sha256': operation,
                                                         'job_path': job})
            self.fault('after_ack')
            last_error = None
            for _ in range(20):
                self._owned(operation)
                try:
                    result = self._fresh_ready(args, service_plan, planned['observation'])
                except Exception as error:
                    last_error = error
                else:
                    # Persistence failures are not transient readiness failures.
                    return self._conclude(operation, 'ready', readiness=result)
                if self.deadline-time.monotonic() <= 1:
                    break
                time.sleep(.25)
            raise ActivateError('activation_not_ready_recovery_required') from last_error

    def status(self):
        with self._held():
            pending = self._reservation()
            operation = pending['operation_sha256'] if pending else None
            attempt = ack = receipt = None
            if operation:
                self._intent(operation)
                attempt, ack, receipt = self._records(operation)
            return {'format': 1, 'pending_sha256': operation,
                    'dispatch_state': self._dispatch(attempt, ack), 'receipt_committed': receipt is not None,
                    'application_ready': 'not_checked', 'manager_observation': 'not_checked',
                    'last_completed': self._last(), 'activation_state_changed': False, **NO_OTHER_ACTIONS}

    def recover(self, expected_pending):
        FS.sha(expected_pending)
        self.deadline = time.monotonic()+30
        with self._held(exclusive=True):
            value = self._reservation()
            need(value is not None and value['operation_sha256'] == expected_pending,
                 'pending_activation_mismatch')
            operation = expected_pending
            intent, args, service_plan = self._intent(operation)
            self.authorized_pending = operation
            baseline = intent['plan']['observation']
            self.manager.deadline = self.deadline
            self.manager.fence_sender(baseline['connection'], intent['sender_name'])
            self._owned(operation)
            attempt, ack, receipt = self._records(operation)
            if receipt is not None:
                self.manager.verify_identity(baseline['connection'])
                return {**self._finish(operation, receipt), 'recovered': True}
            # No StartUnit is sent during recovery. A terminal observation after
            # the sender/manager fence can finish even if its reply was lost.
            rows = self.manager('show')
            console = rows[SERVICES.CONSOLE]
            if console['ActiveState'] in ('inactive', 'failed'):
                after = self._observe(args, service_plan, state='terminal')
                self._same(baseline, after)
                self.manager.verify_identity(baseline['connection'])
                return {**self._conclude(operation, 'not_dispatched' if attempt is None else 'not_running',
                                        fenced=True), 'recovered': True}
            result = self._fresh_ready(args, service_plan, baseline)
            self.manager.verify_identity(baseline['connection'])
            return {**self._conclude(operation, 'ready', readiness=result, fenced=True), 'recovered': True}


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise ActivateError('invalid_arguments')


def main(argv=None, *, context_factory=Context):
    context = None
    try:
        argv = list(sys.argv[1:] if argv is None else argv)
        parser = Parser(description=__doc__, allow_abbrev=False)
        parser.add_argument('action', choices=('prepare', 'plan', 'apply', 'status', 'recover'))
        parser.add_argument('--home')
        parser.add_argument('--bun')
        parser.add_argument('--source')
        parser.add_argument('--port', type=int)
        parser.add_argument('--expected-current')
        parser.add_argument('--expected-instance')
        parser.add_argument('--expected-plan')
        parser.add_argument('--expected-pending')
        flags = [a.partition('=')[0] for a in argv if a.startswith('--')]
        need(len(flags) == len(set(flags)), 'invalid_arguments')
        args = parser.parse_args(argv)
        common = {'--home'}
        if args.action in ('prepare', 'plan', 'apply'):
            common |= {'--bun', '--source', '--port', '--expected-current'}
            need(args.bun is not None and args.expected_current is not None, 'invalid_arguments')
        if args.action in ('plan', 'apply'):
            common.add('--expected-instance')
            need(args.expected_instance is not None, 'invalid_arguments')
        if args.action == 'apply':
            common.add('--expected-plan'); need(args.expected_plan is not None, 'invalid_arguments')
        if args.action == 'recover':
            common.add('--expected-pending'); need(args.expected_pending is not None, 'invalid_arguments')
        need(set(flags) <= common, 'invalid_arguments')
        need(sys.platform == 'linux' and os.getuid() == os.geteuid() != 0,
             'ordinary_linux_account_required')
        # Resolve the account default only after argument/platform validation,
        # and only when neither an explicit nor environment home was supplied.
        home = args.home if args.home is not None else os.environ.get('ULTRABRAIN_HOME')
        if home is None:
            home = str(Path(pwd.getpwuid(os.geteuid()).pw_dir)/'.local/share/ultrabrain')
        context = context_factory(home)
        if args.action in ('prepare', 'plan', 'apply'):
            options = {'bun': args.bun, 'source': args.source if args.source is not None else 'default',
                       'port': args.port if args.port is not None else 3132,
                       'expected_current': args.expected_current}
            if args.action == 'prepare':
                result = context.prepare(**options)
            else:
                options['expected_instance'] = args.expected_instance
                result = (context.plan(**options) if args.action == 'plan' else
                          context.apply(expected_plan=args.expected_plan, **options))
        else:
            result = context.status() if args.action == 'status' else context.recover(args.expected_pending)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=True))
        return 0
    except Exception as error:
        known = isinstance(error, (ActivateError, MANAGER.ActivateManagerError, PREFLIGHT.PreflightError,
                                   SERVICES.ServicePlanError, READY.PROCESS.ReadyError, IDENTITY.IdentityError,
                                   IDENTITY.PREFLIGHT.PreflightError, IDENTITY.FS.DeployError))
        code = str(error) if known and re.fullmatch('[a-z][a-z_]{0,79}', str(error)) else 'personal_activation_failed'
        # Error output never guesses whether a dispatched request took effect.
        print(json.dumps({'ok': False, 'error': code, 'application_ready': False,
                          'activation_outcome': 'not_proven', **NO_OTHER_ACTIONS}))
        return 1
    finally:
        if context is not None:
            context.manager.close()


if __name__ == '__main__':
    sys.exit(main())
