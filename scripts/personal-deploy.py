#!/usr/bin/env python3
"""Install reviewed, stopped personal user units with durable explicit recovery.

Only daemon-reload is issued. Activation and enablement belong to the operator.
The fixed-name lock serializes these installers; another same-UID editor or
systemctl caller must also respect the maintenance window.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import argparse
from contextlib import contextmanager
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import selectors
import signal
import subprocess
import time


def sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVICES = sibling('personal_deploy_services', 'personal-services.py')
FS = sibling('personal_deploy_store', 'personal_deploy_store.py')
DeployError, need = FS.DeployError, FS.need
PERSONAL_UNITS = (SERVICES.TARGET, SERVICES.CONSOLE, SERVICES.WORKER)
PROPERTIES = ('Id', 'Names', 'LoadState', 'ActiveState', 'SubState', 'FragmentPath',
              'DropInPaths', 'NeedDaemonReload', 'Job')
ROOT = Path(__file__).resolve().parents[1]


def public(method):
    def wrapped(*args, **kwargs):
        try:
            return method(*args, **kwargs)
        except (OSError, ValueError, RecursionError, SERVICES.ServicePlanError):
            raise DeployError('unsafe_or_changed_filesystem') from None
    return wrapped


def manager_environment():
    uid = os.geteuid()
    return {'PATH': '/usr/bin:/bin', 'HOME': pwd.getpwuid(uid).pw_dir,
            'LANG': 'C', 'LC_ALL': 'C', 'XDG_RUNTIME_DIR': '/run/user/'+str(uid),
            'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/'+str(uid)+'/bus',
            'SYSTEMD_COLORS': '0', 'SYSTEMD_PAGER': 'cat', 'SYSTEMD_LOG_LEVEL': 'err'}


def run_manager(arguments, *, timeout=5.0, limit=65536):
    command = ['/usr/bin/systemctl', '--user', '--no-pager', '--no-ask-password',
               *arguments]
    try:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, cwd='/', env=manager_environment(),
                                 start_new_session=True)
    except OSError:
        raise DeployError('manager_unavailable') from None
    chunks, size, deadline = [], 0, time.monotonic()+timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, True)
            selector.register(child.stderr, selectors.EVENT_READ, False)
            while selector.get_map():
                remaining = deadline-time.monotonic()
                need(remaining > 0, 'manager_timeout')
                events = selector.select(remaining)
                need(bool(events), 'manager_timeout')
                for key, _ in events:
                    raw = os.read(key.fd, min(4096, limit-size+1))
                    if not raw:
                        selector.unregister(key.fileobj)
                        continue
                    size += len(raw)
                    need(size <= limit, 'manager_output_limit')
                    if key.data:
                        chunks.append(raw)
        child.wait(timeout=max(0.001, deadline-time.monotonic()))
        return child.returncode, b''.join(chunks)
    except subprocess.TimeoutExpired:
        raise DeployError('manager_timeout') from None
    finally:
        if child.returncode is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait()
        child.stdout.close()
        child.stderr.close()


def manager_text(raw):
    need(isinstance(raw, bytes) and len(raw) <= 65536, 'invalid_manager_response')
    try:
        text = raw.decode('utf-8', errors='strict')
    except UnicodeError:
        raise DeployError('invalid_manager_response') from None
    need(not any(ord(c) < 32 and c != '\n' or ord(c) == 127 for c in text),
         'invalid_manager_response')
    return text


class LocalManager:
    def __init__(self):
        self.unit_paths = None

    def __call__(self, action):
        if action == 'reload':
            code, _ = run_manager(['daemon-reload'])
            need(code == 0, 'manager_reload_failed')
            return None
        need(action == 'show', 'invalid_manager_action')
        code, raw = run_manager(['--all', '--property=UnitPath', 'show'])
        text = manager_text(raw)
        need(code == 0 and text.startswith('UnitPath=') and text.count('\n') == 1,
             'manager_unit_paths_unavailable')
        paths = text.rstrip('\n').partition('=')[2].split(' ')
        need(paths and all(p and '\\' not in p for p in paths), 'unsupported_manager_unit_paths')
        self.unit_paths = tuple(FS.absolute(p) for p in paths)
        code, raw = run_manager(['--all', '--property='+','.join(PROPERTIES), 'show', '--',
                                 *PERSONAL_UNITS])
        records = {}
        for block in re.split(r'\n\n+', manager_text(raw).strip('\n')):
            row = {}
            for line in block.split('\n'):
                key, delimiter, value = line.partition('=')
                need(delimiter and key in PROPERTIES and key not in row,
                     'invalid_manager_response')
                row[key] = value
            name = row.get('Id')
            need(name in PERSONAL_UNITS and name not in records and set(row) == set(PROPERTIES),
                 'invalid_manager_response')
            records[name] = row
        need(set(records) == set(PERSONAL_UNITS), 'invalid_manager_response')
        need(code == 0 or code == 5 and any(r['LoadState'] == 'not-found'
             and r['ActiveState'] == 'inactive' for r in records.values()), 'manager_unavailable')
        return records


class Context:
    """Internal engine; only main() supplies authority to the public CLI.

    The optional user_home/manager/fault arguments support isolated tests. They
    have no command-line or environment equivalents and never relax the CLI UID
    gate. `value` is the plan freshly recomputed by the fixed service generator.
    """
    def __init__(self, home, *, user_home=None, manager=None, fault=None):
        self.uid = os.geteuid()
        self.home = FS.absolute(home)
        self.user_home = FS.absolute(user_home or pwd.getpwuid(self.uid).pw_dir)
        self.unit_dir = FS.absolute(self.user_home/'.config/systemd/user')
        self.shared = FS.absolute(self.user_home/'.config/ultrabrain-personal-deployment')
        self.state = FS.absolute(self.home/'personal-deployment')
        self.store = FS.Store(self.uid)
        self.manager = manager or LocalManager()
        self.fault = fault or (lambda label: None)
        self.lock_identity = None

    def _envelope(self, current=None, pending=None, changed=False):
        return {'format': 1, 'current_sha256': current, 'pending_sha256': pending,
                'configuration_changed': changed, 'services_started': False,
                'services_stopped': False, 'enablement_changed': False,
                'model_called': False, 'application_ready': 'not_checked'}

    def _lock_check(self):
        if self.lock_identity is not None:
            raw, identity = self.store.read(self.shared/'lock', limit=0)
            need(raw == b'' and identity == self.lock_identity, 'deployment_lock_changed')

    @contextmanager
    def _lock(self, write=False):
        fd = None
        try:
            try:
                directory = self.store.open_dir(self.shared, private=True)
            except FileNotFoundError:
                if not write:
                    yield
                    return
                directory = self.store.open_dir(self.shared, create=True, private=True)
            try:
                flags = os.O_RDWR if write else os.O_RDONLY
                if write:
                    try:
                        fd = os.open('lock', flags | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=directory)
                        os.fsync(fd)
                        os.fsync(directory)
                    except FileExistsError:
                        fd = os.open('lock', flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                else:
                    try:
                        fd = os.open('lock', flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                    except FileNotFoundError:
                        yield
                        return
                st = os.fstat(fd)
                self.store.regular(st)
                need(st.st_size == 0, 'invalid_deployment_lock')
                try:
                    fcntl.flock(fd, (fcntl.LOCK_EX if write else fcntl.LOCK_SH) | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise DeployError('deployment_busy') from None
                self.store.visible(directory, self.shared)
                self.lock_identity = FS.identity(st)
                self._lock_check()
                yield
            finally:
                os.close(directory)
        finally:
            self.lock_identity = None
            if fd is not None:
                os.close(fd)

    def _receipt(self, receipt_sha):
        FS.sha(receipt_sha, optional=True)
        if receipt_sha is None:
            return None
        value, _ = self.store.read_json(self.state/'receipts'/(receipt_sha+'.json'))
        need(set(value) == {'format', 'home', 'user_home', 'previous', 'deployment_sha256', 'plan'}
             and value['format'] == 1 and value['home'] == str(self.home)
             and value['user_home'] == str(self.user_home) and FS.digest(value) == receipt_sha,
             'invalid_deployment_receipt')
        FS.sha(value['previous'], optional=True)
        FS.sha(value['deployment_sha256'])
        plan = value['plan']
        need(isinstance(plan, dict), 'invalid_deployment_receipt')
        try:
            SERVICES.check_plan(plan, plan.get('plan_sha256'))
        except (SERVICES.ServicePlanError, KeyError, TypeError):
            raise DeployError('invalid_deployment_receipt') from None
        need(all(isinstance(v, str) and len(v.encode()) <= 131072
                 for v in plan['units'].values()), 'invalid_deployment_receipt')
        # Export manifest bytes preserve the fixed generator's insertion order;
        # canonical receipt JSON sorts keys for hashing, so restore that order.
        plan['units'] = {name: plan['units'][name] for name in PERSONAL_UNITS
                         if name in plan['units']}
        generation = self.state/'generations'/plan['plan_sha256']
        with self.store.directory(generation, private=True):
            pass
        SERVICES.verify_export(plan, generation, plan['plan_sha256'])
        return value

    def _current(self):
        value, identity = self.store.read_json(self.state/'current.json', limit=512, optional=True)
        if value is None:
            return None, None
        need(set(value) == {'format', 'receipt_sha256'} and value['format'] == 1,
             'invalid_current_receipt')
        receipt = FS.sha(value['receipt_sha256'])
        self._receipt(receipt)
        return receipt, identity

    def _targets(self, receipt):
        if receipt is None:
            return {name: None for name in PERSONAL_UNITS}
        base = self.state/'generations'/receipt['plan']['plan_sha256']
        return {name: str(base/name) if name in receipt['plan']['units'] else None
                for name in PERSONAL_UNITS}

    def _links(self):
        return {name: self.store.link(self.unit_dir/name) for name in PERSONAL_UNITS}

    def _directory_id(self, path, *, optional=False):
        try:
            with self.store.directory(path, owned=True) as fd:
                return FS.identity(os.fstat(fd))[:5]
        except FileNotFoundError:
            if optional:
                return None
            raise

    def _directories(self):
        return {name: self._directory_id(path, optional=True) for name, path in
                (('home', self.home), ('user_home', self.user_home),
                 ('unit_directory', self.unit_dir), ('state_directory', self.state))}

    def _check_paths(self):
        paths = getattr(self.manager, 'unit_paths', None)
        if paths is None:
            paths = (self.unit_dir,)
        else:
            need(self.unit_dir in paths, 'unsupported_manager_unit_paths')
        extra = {'service.d', 'target.d', 'ultrabrain-.service.d', 'ultrabrain-.target.d',
                 'ultrabrain-personal-.service.d'}
        for name in PERSONAL_UNITS:
            extra.update((name+'.d', name+'.wants', name+'.requires', name+'.upholds'))
        for directory in paths:
            for name in extra:
                need(self.store.absent(directory/name), 'personal_unit_override_refused')
            if directory != self.unit_dir:
                for name in PERSONAL_UNITS:
                    need(self.store.absent(directory/name), 'foreign_unit_search_path')

    def _manager_guard(self, targets, *, transitional=False):
        rows = self.manager('show')
        need(isinstance(rows, dict) and set(rows) == set(PERSONAL_UNITS), 'invalid_manager_response')
        self._check_paths()
        observed = {}
        for name in PERSONAL_UNITS:
            row = rows[name]
            need(isinstance(row, dict) and set(row) == set(PROPERTIES)
                 and row['Id'] == name and all(isinstance(v, str) for v in row.values()),
                 'invalid_manager_response')
            need(row['ActiveState'] == 'inactive' and row['SubState'] in ('dead', 'inactive')
                 and row['Job'] in ('', '0'), 'personal_units_must_be_stopped')
            # Alias names can supply their own dependency directories without
            # appearing in DropInPaths. This fixed-name installer admits none.
            need(row['Names'] == name, 'personal_unit_alias_refused')
            need(row['DropInPaths'] == '', 'personal_unit_override_refused')
            need(row['NeedDaemonReload'] in ('no', 'yes'), 'invalid_manager_response')
            need(transitional or row['NeedDaemonReload'] == 'no', 'manager_reload_required')
            allowed = targets[name]
            if not isinstance(allowed, (tuple, list, set)):
                allowed = (allowed,)
            allowed = set(allowed)
            if row['LoadState'] == 'not-found':
                need(None in allowed and row['FragmentPath'] == '', 'unit_manager_binding_mismatch')
            else:
                need(row['LoadState'] == 'loaded' and row['FragmentPath'] in allowed,
                     'unit_manager_binding_mismatch')
            observed[name] = {key: row[key] for key in PROPERTIES}
        return observed

    def _pending(self):
        local, _ = self.store.read_json(self.state/'pending.json', limit=65536, optional=True)
        shared, _ = self.store.read_json(self.shared/'pending.json', limit=65536, optional=True)
        if shared is not None:
            need(shared.get('home') == str(self.home) and shared.get('user_home') == str(self.user_home),
                 'other_deployment_pending')
        need(local is None or shared is None or local == shared, 'pending_journal_mismatch')
        journal = local if local is not None else shared
        if journal is not None:
            self._validate_journal(journal)
        return journal

    def _validate_journal(self, journal):
        need(set(journal) == {'format', 'home', 'user_home', 'token', 'operation',
             'before_current', 'after_current', 'before_current_id', 'after_current_id',
             'restore_current_id', 'before_links', 'after_links', 'restore_links', 'directories'}
             and journal['format'] == 1 and journal['home'] == str(self.home)
             and journal['user_home'] == str(self.user_home)
             and journal['operation'] in ('apply', 'rollback')
             and isinstance(journal['token'], str) and re.fullmatch('[a-f0-9]{32}', journal['token']),
             'invalid_pending_journal')
        directories = journal['directories']
        need(isinstance(directories, dict) and set(directories) ==
             {'home', 'user_home', 'unit_directory', 'state_directory', 'shared', 'link_stage', 'state_stage'},
             'invalid_pending_journal')
        for value in directories.values():
            need(isinstance(value, list) and len(value) == 5
                 and all(type(n) is int and n >= 0 for n in value)
                 and value[3] == self.uid, 'invalid_pending_journal')
        for side in ('before', 'after', 'restore'):
            current = journal[('before' if side == 'restore' else side)+'_current']
            receipt = self._receipt(current)
            targets = self._targets(receipt)
            entries = journal[side+'_links']
            need(isinstance(entries, dict) and set(entries) == set(PERSONAL_UNITS), 'invalid_pending_journal')
            for name, entry in entries.items():
                if targets[name] is None:
                    need(entry is None, 'invalid_pending_journal')
                else:
                    need(isinstance(entry, dict) and set(entry) == {'target', 'identity'}
                         and entry['target'] == targets[name], 'invalid_pending_journal')
                    self._valid_identity(entry['identity'])
            ident = journal[side+'_current_id']
            if current is None:
                need(ident is None, 'invalid_pending_journal')
            else:
                self._valid_identity(ident)

    def _valid_identity(self, ident):
        need(isinstance(ident, list) and len(ident) == 6
             and all(type(n) is int and n >= 0 for n in ident)
             and ident[3] == self.uid and ident[5] == 1, 'invalid_pending_journal')

    def _observe(self, value, export, expected):
        SERVICES.check_plan(value, expected)
        with self.store.directory(self.home, private=True):
            pass
        with self.store.directory(export, private=True):
            pass
        SERVICES.verify_export(value, export, expected)
        need(self._pending() is None, 'deployment_pending')
        current, current_identity = self._current()
        old = self._receipt(current)
        targets = self._targets(old)
        links = self._links()
        for name in PERSONAL_UNITS:
            need((links[name]['target'] if links[name] else None) == targets[name], 'foreign_unit_file')
        rows = self._manager_guard(targets)
        self._lock_check()
        body = {'format': 1, 'home': str(self.home), 'user_home': str(self.user_home),
                'unit_directory': str(self.unit_dir), 'plan_sha256': expected,
                'current_sha256': current, 'current_identity': current_identity,
                'directories': self._directories(),
                'observed_links': links, 'manager': rows,
                'unit_names': sorted(value['units']), 'maintenance': 'all_personal_units_stopped'}
        return {**body, 'deployment_sha256': FS.digest(body), 'changes_made': False,
                'services_started': False, 'application_ready': 'not_checked'}

    @public
    def plan(self, value, export, expected_plan):
        with self._lock():
            return self._observe(value, FS.absolute(export), expected_plan)

    @public
    def status(self):
        with self._lock():
            journal = self._pending()
            current, _ = self._current()
            receipt = self._receipt(current)
            if journal is None:
                targets, links = self._targets(receipt), self._links()
                for name in PERSONAL_UNITS:
                    need((links[name]['target'] if links[name] else None) == targets[name], 'foreign_unit_file')
            return {**self._envelope(current, FS.digest(journal) if journal else None),
                    'installed': current is not None,
                    'unit_paths': self._targets(receipt),
                    'filesystem_binding_verified': journal is None,
                    'installation_binding_verified': False, 'manager_binding': 'not_checked',
                    'plan_sha256': receipt['plan']['plan_sha256'] if receipt else None,
                    'worker_in_generation': SERVICES.WORKER in receipt['plan']['units'] if receipt else False,
                    'pending_operation': journal['operation'] if journal else None,
                    'recovery_restores_sha256': journal['before_current'] if journal else None}

    def _prepare_directories(self, observed):
        with self.store.directory(self.home, private=True):
            pass
        with self.store.directory(self.unit_dir, create=True, owned=True):
            pass
        for path in (self.state, self.state/'generations', self.state/'receipts'):
            self.store.mkdir(path)
        directories = self._directories()
        for name, value in observed.items():
            need(value is None or directories[name] == value, 'directory_changed')
        return directories

    def _write_generation(self, value, export):
        path = self.state/'generations'/value['plan_sha256']
        if self.store.absent(path):
            # A crashed copy stays unreferenced; retry can create another staging
            # copy without adopting or deleting unknown incomplete files.
            staging = path.parent/('.incoming-'+secrets.token_hex(16))
            SERVICES.export_plan(value, staging, value['plan_sha256'])
            self.store.replace(staging, path, absent_expected=True)
        SERVICES.verify_export(value, path, value['plan_sha256'])
        SERVICES.verify_export(value, export, value['plan_sha256'])

    def _write_receipt(self, receipt):
        digest = FS.digest(receipt)
        path = self.state/'receipts'/(digest+'.json')
        if self.store.absent(path):
            self._atomic_new(path, FS.canonical(receipt))
        value, _ = self.store.read_json(path)
        need(value == receipt, 'deployment_receipt_changed')
        return digest

    def _atomic_new(self, path, raw):
        staging = path.parent/('.incoming-'+secrets.token_hex(16))
        self.store.write_new(staging, raw)
        self.store.replace(staging, path, absent_expected=True)

    def _stages(self, journal):
        token = journal['token']
        return (self.unit_dir/('.ultrabrain-personal-deploy-'+token),
                self.state/('.transaction-'+token))

    def _make_journal(self, operation, before, after, observed):
        journal = {'format': 1, 'home': str(self.home), 'user_home': str(self.user_home),
                   'token': secrets.token_hex(16), 'operation': operation,
                   'before_current': before, 'after_current': after,
                   'before_current_id': self._current()[1], 'after_current_id': None,
                   'restore_current_id': None, 'before_links': observed,
                   'after_links': {}, 'restore_links': {}, 'directories': {}}
        link_stage, state_stage = self._stages(journal)
        self.store.mkdir(link_stage, exclusive=True)
        self.store.mkdir(state_stage, exclusive=True)
        journal['directories'] = {**self._directories(),
                                  'shared': self._directory_id(self.shared),
                                  'link_stage': self._directory_id(link_stage),
                                  'state_stage': self._directory_id(state_stage)}
        for side, target_receipt in (('after', after), ('restore', before)):
            targets = self._targets(self._receipt(target_receipt))
            for name in PERSONAL_UNITS:
                journal[side+'_links'][name] = (self.store.symlink_new(targets[name], link_stage/(side+'-'+name))
                                              if targets[name] is not None else None)
            if target_receipt is not None:
                path = state_stage/(side+'-current.json')
                self.store.write_new(path, FS.canonical({'format': 1, 'receipt_sha256': target_receipt}))
                journal[side+'_current_id'] = self.store.read(path, limit=512)[1]
        self._validate_journal(journal)
        return journal

    def _publish_journal(self, journal):
        need(self._pending() is None, 'deployment_pending')
        # Reserve the shared fixed-name namespace before publishing the local
        # mirror. A crash between these writes must still block other homes.
        self._atomic_new(self.shared/'pending.json', FS.canonical(journal))
        self._atomic_new(self.state/'pending.json', FS.canonical(journal))
        self.fault('after_journal')

    def _check_transaction(self, journal):
        self._lock_check()
        need(self._pending() == journal, 'pending_journal_changed')
        link_stage, state_stage = self._stages(journal)
        directories = {**self._directories(), 'shared': self._directory_id(self.shared),
                       'link_stage': self._directory_id(link_stage),
                       'state_stage': self._directory_id(state_stage)}
        need(directories == journal['directories'], 'transaction_directory_changed')
        links = self._links()
        for name, link in links.items():
            need(any(link == journal[side+'_links'][name] for side in ('before', 'after', 'restore')),
                 'transaction_unit_changed')
        current, current_identity = self._current()
        need(any(current == journal[('before' if side == 'restore' else side)+'_current']
                 and current_identity == journal[side+'_current_id'] for side in ('before', 'after', 'restore')),
             'transaction_current_changed')
        self._check_stages(journal, links, current_identity)
        targets = {name: tuple(journal[side+'_links'][name]['target']
                   if journal[side+'_links'][name] else None for side in ('before', 'after'))
                   for name in PERSONAL_UNITS}
        self._manager_guard(targets, transitional=True)
        return links, current, current_identity

    def _check_stages(self, journal, links, current_identity):
        link_stage, state_stage = self._stages(journal)
        expected_links, expected_files = set(), set()
        for side in ('after', 'restore'):
            for name, entry in journal[side+'_links'].items():
                if entry is None:
                    continue
                filename = side+'-'+name
                actual = self.store.link(link_stage/filename)
                if actual is None:
                    need(links[name] == entry or side == 'after'
                         and links[name] == journal['restore_links'][name], 'transaction_stage_changed')
                else:
                    need(actual == entry, 'transaction_stage_changed')
                    expected_links.add(filename)
            ident = journal[side+'_current_id']
            if ident is None:
                continue
            filename = side+'-current.json'
            value, actual = self.store.read_json(state_stage/filename, limit=512, optional=True)
            if value is None:
                need(current_identity == ident or side == 'after'
                     and current_identity == journal['restore_current_id'], 'transaction_stage_changed')
            else:
                wanted = journal[('before' if side == 'restore' else side)+'_current']
                need(value == {'format': 1, 'receipt_sha256': wanted} and actual == ident,
                     'transaction_stage_changed')
                expected_files.add(filename)
        for path, expected in ((link_stage, expected_links), (state_stage, expected_files)):
            with self.store.directory(path, private=True) as fd:
                need(set(os.listdir(fd)) == expected, 'transaction_stage_inventory_changed')

    def _change_links(self, journal, side, verify=None):
        link_stage, _ = self._stages(journal)
        changed = False
        for name in PERSONAL_UNITS:
            links, _, _ = self._check_transaction(journal)
            if verify:
                verify()
            self.fault('before_unit:'+name)
            links, _, _ = self._check_transaction(journal)
            wanted = journal[side+'_links'][name]
            if (links[name]['target'] if links[name] else None) == (wanted['target'] if wanted else None):
                continue
            if wanted is None:
                self.store.remove(self.unit_dir/name)
            else:
                self.store.replace(link_stage/(side+'-'+name), self.unit_dir/name,
                                   absent_expected=links[name] is None)
            changed = True
            self.fault('after_unit:'+name)
        return changed

    def _change_current(self, journal, side):
        _, _, state_identity = self._check_transaction(journal)
        wanted = journal[('before' if side == 'restore' else side)+'_current']
        self.fault('before_current')
        _, current, state_identity = self._check_transaction(journal)
        if current == wanted:
            return
        if wanted is None:
            self.store.remove(self.state/'current.json')
        else:
            _, stage = self._stages(journal)
            self.store.replace(stage/(side+'-current.json'), self.state/'current.json',
                               absent_expected=state_identity is None)
        self.fault('after_current')

    def _reload(self, journal, side, *, changed=True):
        self._check_transaction(journal)
        wanted = self._targets(self._receipt(journal[('before' if side == 'restore' else side)+'_current']))
        if not changed:
            try:
                self._manager_guard(wanted)
                return
            except DeployError as error:
                need(str(error) in ('manager_reload_required', 'unit_manager_binding_mismatch'), str(error))
        self.fault('before_reload')
        self.manager('reload')
        self.fault('after_reload')
        self._check_transaction(journal)
        self._manager_guard(wanted)

    def _clear(self, journal):
        self._check_transaction(journal)
        self.fault('before_clear_pending')
        self._check_transaction(journal)
        for path in (self.state/'pending.json', self.shared/'pending.json'):
            value, _ = self.store.read_json(path, limit=65536, optional=True)
            if value is not None:
                need(value == journal, 'pending_journal_changed')
                self.store.remove(path)
        self.fault('after_clear_pending')

    def _restore(self, journal):
        changed = self._change_links(journal, 'restore')
        self._change_current(journal, 'restore')
        self._reload(journal, 'restore', changed=changed)
        self._clear(journal)
        return changed

    def _execute(self, journal, verify=None):
        try:
            self._publish_journal(journal)
            self._change_links(journal, 'after', verify)
            self._change_current(journal, 'after')
            self._reload(journal, 'after')
            self._clear(journal)
        except Exception:
            try:
                pending = self._pending()
                if pending is not None:
                    need(pending == journal, 'pending_journal_changed')
                    self._restore(journal)
                else:
                    # No journal means either no mutation was authorized yet,
                    # or the transaction already committed its cleanup.
                    current, _ = self._current()
                    if current == journal['after_current']:
                        return
            except Exception:
                raise DeployError('deployment_recovery_required') from None
            raise DeployError('deployment_failed_restored') from None

    @public
    def apply(self, value, export, expected_plan, expected_deployment):
        export = FS.absolute(export)
        FS.sha(expected_deployment)
        # A wrong reviewed hash has no filesystem side effects, including locks.
        with self._lock():
            observed = self._observe(value, export, expected_plan)
            need(observed['deployment_sha256'] == expected_deployment, 'deployment_plan_mismatch')
        with self._lock(write=True):
            observed = self._observe(value, export, expected_plan)
            need(observed['deployment_sha256'] == expected_deployment, 'deployment_plan_mismatch')
            before = observed['current_sha256']
            prior = self._receipt(before)
            if prior is not None and prior['plan'] == value:
                return {**self._envelope(before), 'installed': True, 'plan_sha256': expected_plan,
                        'unit_paths': self._targets(prior)}
            directories = self._prepare_directories(observed['directories'])
            self._write_generation(value, export)
            receipt = {'format': 1, 'home': str(self.home), 'user_home': str(self.user_home),
                       'previous': before, 'deployment_sha256': expected_deployment, 'plan': value}
            after = self._write_receipt(receipt)
            journal = self._make_journal('apply', before, after, observed['observed_links'])
            final_observation = self._observe(value, export, expected_plan)
            need(final_observation['directories'] == directories, 'directory_changed')
            need(all(final_observation[key] == val for key, val in observed.items()
                     if key not in ('deployment_sha256', 'directories')), 'deployment_plan_mismatch')
            self._execute(journal, lambda: SERVICES.verify_export(value, export, expected_plan))
            return {**self._envelope(after, changed=True), 'installed': True,
                    'plan_sha256': expected_plan, 'previous_sha256': before,
                    'unit_paths': self._targets(receipt)}

    @public
    def rollback(self, expected_current):
        FS.sha(expected_current)
        with self._lock(write=True):
            need(self._pending() is None, 'deployment_pending')
            current, _ = self._current()
            need(current == expected_current, 'current_deployment_mismatch')
            receipt = self._receipt(current)
            self._receipt(receipt['previous'])
            links, targets = self._links(), self._targets(receipt)
            for name in PERSONAL_UNITS:
                need((links[name]['target'] if links[name] else None) == targets[name], 'foreign_unit_file')
            self._manager_guard(targets)
            journal = self._make_journal('rollback', current, receipt['previous'], links)
            self._execute(journal)
            return {**self._envelope(receipt['previous'], changed=True),
                    'installed': receipt['previous'] is not None, 'rolled_back': True,
                    'unit_paths': self._targets(self._receipt(receipt['previous']))}

    @public
    def recover(self, expected_pending):
        FS.sha(expected_pending)
        with self._lock(write=True):
            journal = self._pending()
            need(journal is not None and FS.digest(journal) == expected_pending, 'pending_deployment_mismatch')
            try:
                changed = self._restore(journal)
            except Exception:
                raise DeployError('deployment_recovery_required') from None
            return {**self._envelope(journal['before_current'], changed=changed),
                    'installed': journal['before_current'] is not None, 'recovered': True,
                    'unit_paths': self._targets(self._receipt(journal['before_current']))}


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise DeployError('invalid_arguments')


def main(argv=None):
    parser = SafeParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True, parser_class=SafeParser)
    for action in ('plan', 'apply', 'status', 'rollback', 'recover'):
        sub = commands.add_parser(action)
        sub.add_argument('--home', default=os.environ.get('ULTRABRAIN_HOME',
                         str(Path(pwd.getpwuid(os.geteuid()).pw_dir)/'.local/share/ultrabrain')))
        if action in ('plan', 'apply'):
            sub.add_argument('--export', required=True)
            sub.add_argument('--expected-plan', required=True)
            sub.add_argument('--bun', required=True)
            sub.add_argument('--source', default='default')
            sub.add_argument('--port', type=int, default=3132)
            sub.add_argument('--worker', action='store_true')
            sub.add_argument('--allow-model-call', action='store_true')
            sub.add_argument('--interval', type=int, default=300)
        if action == 'apply':
            sub.add_argument('--expected-deployment', required=True)
        if action == 'rollback':
            sub.add_argument('--expected-current', required=True)
        if action == 'recover':
            sub.add_argument('--expected-pending', required=True)
    try:
        args = parser.parse_args(argv)
        need(sys.platform == 'linux' and os.getuid() == os.geteuid() and os.geteuid() != 0,
             'ordinary_linux_account_required')
        context = Context(args.home)
        if args.action in ('plan', 'apply'):
            value = SERVICES.plan(ROOT, args.home, args.bun, source=args.source, port=args.port,
                                  worker=args.worker, allow_model_call=args.allow_model_call,
                                  interval=args.interval)
            if args.action == 'plan':
                result = context.plan(value, args.export, args.expected_plan)
            else:
                result = context.apply(value, args.export, args.expected_plan, args.expected_deployment)
        elif args.action == 'status':
            result = context.status()
        elif args.action == 'rollback':
            result = context.rollback(args.expected_current)
        else:
            result = context.recover(args.expected_pending)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=True))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, DeployError) else 'personal_deployment_failed'
        print(json.dumps({'ok': False, 'error': code, 'services_started': False,
                          'services_stopped': False, 'application_ready': 'not_checked',
                          'note': 'Inspect personal-deploy status; retain any pending recovery journal.'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
