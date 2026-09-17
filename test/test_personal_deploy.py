"""Deployment behavior in private temporary directories with a fixture manager.

These tests exercise real files, symlinks and locks. The manager is explicitly
injected; these results are not evidence of a live systemd user deployment.
"""
import contextlib
import copy
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    'personal_deploy_tested', ROOT / 'scripts/personal-deploy.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
s = m.SERVICES


class SimulatedPowerLoss(BaseException):
    """Escape ordinary exception compensation, preserving the pending record."""


class ForbiddenManagerAction(BaseException):
    """Do not let deployment compensation swallow a forbidden service action."""


class FixtureManager:
    """Cached manager rows change only when the fixture reloads its unit files."""

    def __init__(self, units):
        self.units = units
        self.actions = []
        self.reloads = 0
        self.overrides = {}
        self.fail_reloads = set()
        self.crash_reloads = set()
        self.before_action = None
        self.rows = {name: self.absent(name) for name in m.PERSONAL_UNITS}

    @staticmethod
    def absent(name):
        return dict(Id=name, Names=name, LoadState='not-found', ActiveState='inactive',
                    SubState='dead', FragmentPath='', DropInPaths='',
                    NeedDaemonReload='no', Job='')

    def read_units(self):
        for name in m.PERSONAL_UNITS:
            row = self.absent(name)
            path = self.units / name
            if path.is_symlink() and path.exists():
                row.update(LoadState='loaded', FragmentPath=str(path.resolve()))
            elif path.exists():
                row.update(LoadState='loaded', FragmentPath=str(path))
            self.rows[name] = row

    def __call__(self, action):
        # An added start/stop/enable operation fails loudly in every test.
        self.actions.append(action)
        if action not in ('show', 'reload'):
            raise ForbiddenManagerAction('unexpected manager mutation: ' + str(action))
        if self.before_action:
            self.before_action(action)
        if action == 'reload':
            self.reloads += 1
            if self.reloads in self.crash_reloads:
                raise SimulatedPowerLoss('synthetic interruption during reload')
            if self.reloads in self.fail_reloads:
                raise m.DeployError('fixture_reload_failed')
            self.read_units()
            return None
        rows = copy.deepcopy(self.rows)
        for name, properties in self.overrides.items():
            rows[name].update(properties)
        return rows


def tree_snapshot(root):
    """Content/mode snapshot without dereferencing links or depending on atime."""
    result = {}
    if not root.exists():
        return result
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(base) / name
            st = path.lstat()
            relative = str(path.relative_to(root))
            if stat.S_ISLNK(st.st_mode):
                contents = ('link', os.readlink(path))
            elif stat.S_ISREG(st.st_mode):
                contents = ('file', path.read_bytes())
            elif stat.S_ISDIR(st.st_mode):
                contents = ('directory',)
            else:
                contents = ('special', stat.S_IFMT(st.st_mode))
            result[relative] = (st.st_dev, st.st_ino, stat.S_IMODE(st.st_mode),
                                st.st_uid, contents)
    return result


class DeploymentFixtureTests(unittest.TestCase):
    def setUp(self):
        old_mask = os.umask(0o077)
        self.addCleanup(os.umask, old_mask)
        tmp = tempfile.TemporaryDirectory(prefix='ub-deploy-fixture-')
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.account = self.root / 'account'
        self.home = self.root / 'data'
        self.account.mkdir(mode=0o700)
        self.home.mkdir(mode=0o700)
        self.units = self.account / '.config/systemd/user'
        self.units.mkdir(mode=0o700, parents=True)
        self.manager = FixtureManager(self.units)
        self.addCleanup(lambda: self.assertTrue(
            set(self.manager.actions) <= {'show', 'reload'}, self.manager.actions))
        self.context = m.Context(self.home, user_home=self.account,
                                 manager=self.manager)
        self.export_count = 0

    def export(self, **options):
        self.export_count += 1
        destination = self.root / ('export-' + str(self.export_count))
        value = s.plan(ROOT, self.home, '/usr/bin/bun', **options)
        s.export_plan(value, destination, value['plan_sha256'])
        return value, destination

    def review(self, pair):
        value, destination = pair
        return self.context.plan(value, destination, value['plan_sha256'])

    def apply(self, pair, reviewed=None):
        value, destination = pair
        reviewed = reviewed or self.review(pair)
        return self.context.apply(value, destination, value['plan_sha256'],
                                  reviewed['deployment_sha256'])

    def links(self):
        return {name: os.readlink(self.units / name)
                for name in m.PERSONAL_UNITS if (self.units / name).is_symlink()}

    def assert_installed(self, pair):
        value, export = pair
        self.assertEqual(set(self.links()), set(value['units']))
        generation_directories = set()
        for name, content in value['units'].items():
            target = Path(os.readlink(self.units / name))
            self.assertTrue(target.is_absolute())
            self.assertNotEqual(target.parent, export)
            self.assertTrue(target.is_relative_to(self.home / 'personal-deployment'))
            self.assertEqual(target.read_bytes(), content.encode())
            self.assertEqual(target.stat().st_uid, os.geteuid())
            self.assertEqual(target.stat().st_mode & 0o077, 0)
            self.assertEqual(target.stat().st_nlink, 1)
            generation_directories.add(target.parent)
        self.assertEqual(len(generation_directories), 1)
        self.assertFalse((self.units / s.DATABASE).exists())
        self.assertTrue(set(self.manager.actions) <= {'show', 'reload'})

    def assert_refused_without_changes(self, operation, pattern=None):
        before = tree_snapshot(self.root)
        reloads = self.manager.reloads
        if pattern:
            with self.assertRaisesRegex(m.DeployError, pattern):
                operation()
        else:
            with self.assertRaises(m.DeployError):
                operation()
        self.assertEqual(tree_snapshot(self.root), before)
        self.assertEqual(self.manager.reloads, reloads)

    def context_with_fault(self, callback):
        return m.Context(self.home, user_home=self.account,
                         manager=self.manager, fault=callback)

    def interrupt_apply(self, pair, label):
        fired = []

        def interrupt(observed):
            if observed == label:
                fired.append(observed)
                raise SimulatedPowerLoss('synthetic ' + observed)

        value, destination = pair
        reviewed = self.review(pair)
        context = self.context_with_fault(interrupt)
        with self.assertRaises(SimulatedPowerLoss):
            context.apply(value, destination, value['plan_sha256'],
                          reviewed['deployment_sha256'])
        self.assertEqual(fired, [label])
        pending = self.context.status()['pending_sha256']
        self.assertIsInstance(pending, str)
        self.assertEqual(len(pending), 64)
        return pending

    def test_plan_is_read_only_and_deterministic(self):
        pair = self.export()
        before = tree_snapshot(self.root)
        first = self.review(pair)
        second = self.review(pair)
        self.assertEqual(first, second)
        self.assertEqual(tree_snapshot(self.root), before)
        self.assertEqual(self.manager.reloads, 0)
        self.assertEqual(len(first['deployment_sha256']), 64)

    def test_fresh_account_plan_leaves_unit_directory_absent_then_apply_creates_it(self):
        shutil.rmtree(self.account / '.config')
        pair = self.export()
        before = tree_snapshot(self.root)
        reviewed = self.review(pair)
        self.assertEqual(tree_snapshot(self.root), before)
        self.assertFalse((self.account / '.config').exists())
        self.apply(pair, reviewed)
        self.assert_installed(pair)
        for suffix in ('.config', '.config/systemd', '.config/systemd/user'):
            self.assertEqual((self.account / suffix).stat().st_mode & 0o777, 0o700)

    def test_existing_empty_unit_directory_replacement_invalidates_review(self):
        pair = self.export()
        reviewed = self.review(pair)
        original = self.units.stat()
        self.units.rename(self.root / 'original-empty-unit-directory')
        self.units.mkdir(mode=0o700)
        replacement = self.units.stat()
        self.assertNotEqual((original.st_dev, original.st_ino),
                            (replacement.st_dev, replacement.st_ino))
        self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))

    def test_first_install_copies_private_generation_and_reloads_only(self):
        pair = self.export()
        self.apply(pair)
        self.assert_installed(pair)
        self.assertEqual(self.manager.reloads, 1)
        self.assertIs(self.context.status()['services_started'], False)

    def test_identical_reapplication_keeps_receipt_links_and_reload_count(self):
        self.apply(self.export())
        current = self.context.status()['current_sha256']
        identical = self.export()
        reviewed = self.review(identical)
        before = tree_snapshot(self.root)
        reloads = self.manager.reloads
        result = self.apply(identical, reviewed)
        self.assertEqual(result['current_sha256'], current)
        self.assertEqual(tree_snapshot(self.root), before)
        self.assertEqual(self.manager.reloads, reloads)

    def test_export_edits_after_install_do_not_change_deployed_units(self):
        pair = self.export()
        self.apply(pair)
        before = {name: (self.units / name).read_bytes() for name in pair[0]['units']}
        for name in pair[0]['units']:
            (pair[1] / name).write_text('unreviewed export edit\n')
        shutil.rmtree(pair[1])
        self.assertEqual({name: (self.units / name).read_bytes() for name in before}, before)
        self.context.status()

    def test_update_changes_generation_preserving_previous_bytes(self):
        first = self.export(port=3132)
        self.apply(first)
        previous = self.links()
        second = self.export(port=4132)
        self.apply(second)
        self.assert_installed(second)
        self.assertNotEqual(self.links()[s.CONSOLE], previous[s.CONSOLE])
        for name, target in previous.items():
            self.assertEqual(Path(target).read_bytes(), first[0]['units'][name].encode())
        self.assertEqual(self.manager.reloads, 2)

    def test_update_can_remove_previously_authorized_worker(self):
        first = self.export(worker=True, allow_model_call=True)
        self.apply(first)
        self.assertTrue((self.units / s.WORKER).is_symlink())
        second = self.export()
        self.apply(second)
        self.assert_installed(second)
        self.assertFalse(os.path.lexists(self.units / s.WORKER))
        self.assertEqual(self.manager.reloads, 2)

    def test_wrong_service_plan_hash_cannot_create_deployment(self):
        pair = self.export()
        reviewed = self.review(pair)
        self.assert_refused_without_changes(
            lambda: self.context.apply(pair[0], pair[1], '0' * 64,
                                       reviewed['deployment_sha256']))

    def test_wrong_deployment_hash_cannot_create_deployment(self):
        pair = self.export()
        self.review(pair)
        self.assert_refused_without_changes(
            lambda: self.context.apply(pair[0], pair[1], pair[0]['plan_sha256'], '0' * 64))

    def test_stale_review_cannot_overwrite_later_installation(self):
        first = self.export()
        stale = self.review(first)
        second = self.export(port=4132)
        self.apply(second)
        self.assert_refused_without_changes(lambda: self.apply(first, stale))
        self.assert_installed(second)

    def test_foreign_regular_unit_is_preserved(self):
        pair = self.export()
        path = self.units / s.CONSOLE
        path.write_text('[Service]\nExecStart=/bin/true\n')
        self.assert_refused_without_changes(lambda: self.review(pair))

    def test_foreign_symlink_and_mask_are_preserved(self):
        pair = self.export()
        path = self.units / s.CONSOLE
        foreign = self.root / 'foreign.service'
        foreign.write_text('[Service]\nExecStart=/bin/true\n')
        for target in (foreign, Path('/dev/null'), self.root / 'nonexistent.service'):
            with self.subTest(target=str(target)):
                path.symlink_to(target)
                self.assert_refused_without_changes(lambda: self.review(pair))
                path.unlink()

    def test_foreign_dropin_directory_is_preserved(self):
        pair = self.export()
        dropin = self.units / (s.CONSOLE + '.d')
        dropin.mkdir(mode=0o700)
        (dropin / 'override.conf').write_text('[Service]\nEnvironment=PRIVATE\n')
        self.assert_refused_without_changes(lambda: self.review(pair))

    def test_generic_and_prefix_dropins_are_refused_before_first_install(self):
        pair = self.export()
        for name in ('service.d', 'target.d', 'ultrabrain-.service.d',
                     'ultrabrain-.target.d', 'ultrabrain-personal-.service.d'):
            with self.subTest(name=name):
                dropin = self.units / name
                dropin.mkdir(mode=0o700)
                (dropin / 'override.conf').write_text('[Unit]\nDescription=override\n')
                self.assert_refused_without_changes(lambda: self.review(pair))
                shutil.rmtree(dropin)

    def test_foreign_unit_in_manager_search_path_is_not_shadowed(self):
        pair = self.export()
        extra = self.root / 'extra-manager-unit-path'
        extra.mkdir(mode=0o700)
        self.manager.unit_paths = (self.units, extra)
        (extra / s.CONSOLE).write_text('[Service]\nExecStart=/bin/true\n')
        self.assert_refused_without_changes(lambda: self.review(pair))

    def test_standard_distro_unit_path_alias_is_readable_without_plan_mutation(self):
        alias = Path('/etc/xdg/systemd/user')
        if not alias.is_symlink():
            self.skipTest('this distribution does not use the supported unit-path alias')
        before_alias = alias.lstat()
        self.assertEqual(before_alias.st_uid, 0)
        self.assertIn(os.readlink(alias), ('../../systemd/user', '/etc/systemd/user'))
        self.assertEqual(m.FS.manager_scan_path(alias), Path('/etc/systemd/user'))
        pair = self.export()
        self.manager.unit_paths = (self.units, alias)
        before = tree_snapshot(self.root)
        reviewed = self.review(pair)
        self.assertEqual(len(reviewed['deployment_sha256']), 64)
        self.assertEqual(tree_snapshot(self.root), before)
        self.assertEqual(self.manager.reloads, 0)
        after_alias = alias.lstat()
        self.assertEqual((after_alias.st_dev, after_alias.st_ino, after_alias.st_mode,
                          after_alias.st_uid, after_alias.st_mtime_ns, after_alias.st_ctime_ns),
                         (before_alias.st_dev, before_alias.st_ino, before_alias.st_mode,
                          before_alias.st_uid, before_alias.st_mtime_ns, before_alias.st_ctime_ns))

    def test_user_controlled_unit_path_alias_remains_refused(self):
        pair = self.export()
        canonical = self.root / 'canonical-extra-unit-directory'
        canonical.mkdir(mode=0o700)
        alias = self.root / 'user-controlled-unit-path'
        for target in (canonical, Path('/etc/systemd/user')):
            with self.subTest(target=str(target)):
                alias.symlink_to(target, target_is_directory=True)
                self.manager.unit_paths = (self.units, alias)
                self.assertEqual(m.FS.manager_scan_path(alias), alias)
                self.assert_refused_without_changes(lambda: self.review(pair))
                alias.unlink()

    def test_standard_distro_alias_still_checks_canonical_override_inventory(self):
        alias = Path('/etc/xdg/systemd/user')
        if not alias.is_symlink():
            self.skipTest('this distribution does not use the supported unit-path alias')
        pair = self.export()
        self.manager.unit_paths = (self.units, alias)
        original_absent = self.context.store.absent
        override = Path('/etc/systemd/user') / (s.CONSOLE + '.upholds')
        checked = []

        def synthetic_override(path):
            if path == override:
                checked.append(path)
                return False
            return original_absent(path)

        # Report a synthetic canonical dependency directory; never write /etc.
        with patch.object(self.context.store, 'absent', side_effect=synthetic_override):
            self.assert_refused_without_changes(lambda: self.review(pair))
        self.assertEqual(checked, [override])

    def test_upholds_dependencies_in_every_unit_path_are_refused_before_mutation(self):
        pair = self.export()
        extra = self.root / 'extra-upholds-unit-path'
        extra.mkdir(mode=0o700)
        self.manager.unit_paths = (self.units, extra)
        for directory in self.manager.unit_paths:
            for name in m.PERSONAL_UNITS:
                with self.subTest(directory=directory.name, name=name):
                    reviewed = self.review(pair)
                    dependency = directory / (name + '.upholds')
                    dependency.mkdir(mode=0o700)
                    (dependency / 'unreviewed.service').symlink_to('/tmp/unreviewed.service')
                    self.assert_refused_without_changes(lambda: self.review(pair))
                    self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))
                    shutil.rmtree(dependency)

    def test_active_and_transitioning_units_are_refused(self):
        pair = self.export()
        for active, sub in (('active', 'running'), ('activating', 'start'),
                            ('deactivating', 'stop-sigterm'), ('failed', 'failed')):
            with self.subTest(active=active):
                self.manager.overrides = {s.CONSOLE: dict(ActiveState=active, SubState=sub)}
                self.assert_refused_without_changes(lambda: self.review(pair))

    def test_foreign_manager_fragment_and_manager_dropin_are_refused(self):
        pair = self.export()
        for properties in (dict(LoadState='loaded', FragmentPath='/tmp/foreign.service'),
                           dict(DropInPaths='/tmp/override.conf'),
                           dict(NeedDaemonReload='yes'),
                           dict(Job='42')):
            with self.subTest(properties=properties):
                self.manager.overrides = {s.CONSOLE: properties}
                self.assert_refused_without_changes(lambda: self.review(pair))

    def test_manager_alias_names_refuse_update_without_mutating_installed_units(self):
        self.apply(self.export())
        pair = self.export(port=4132)
        reviewed = self.review(pair)
        for names in (s.CONSOLE + ' unreviewed-alias.service',
                      'unreviewed-alias.service ' + s.CONSOLE):
            with self.subTest(names=names):
                self.manager.overrides = {s.CONSOLE: dict(Names=names)}
                self.assert_refused_without_changes(lambda: self.review(pair))
                self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))

    def test_manager_becoming_active_after_review_prevents_apply(self):
        pair = self.export()
        reviewed = self.review(pair)
        self.manager.overrides = {s.CONSOLE: dict(ActiveState='active', SubState='running')}
        self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))

    def test_missing_manager_unit_record_is_not_assumed_absent(self):
        pair = self.export()
        self.manager.rows.pop(s.WORKER)
        self.assert_refused_without_changes(lambda: self.review(pair))

    def test_malformed_manager_properties_cannot_authorize_deployment(self):
        pair = self.export()
        for properties in (dict(Id='foreign.service'), dict(LoadState='unknown'),
                           dict(SubState='unknown'), dict(NeedDaemonReload=True),
                           dict(Job='unrecognized'), dict(DropInPaths=[])):
            with self.subTest(properties=properties):
                self.manager.overrides = {s.CONSOLE: properties}
                self.assert_refused_without_changes(lambda: self.review(pair))

    def test_local_edit_after_review_is_not_overwritten(self):
        pair = self.export()
        reviewed = self.review(pair)
        (self.units / s.CONSOLE).write_text('concurrent manual installation\n')
        self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))

    def test_unrelated_units_and_database_are_not_modified(self):
        database = self.units / s.DATABASE
        other = self.units / 'other.service'
        database.write_text('existing database service fixture\n')
        other.write_text('unrelated user service fixture\n')
        self.apply(self.export())
        self.assertEqual(database.read_text(), 'existing database service fixture\n')
        self.assertEqual(other.read_text(), 'unrelated user service fixture\n')

    def test_first_install_rollback_restores_absence(self):
        pair = self.export()
        self.apply(pair)
        current = self.context.status()['current_sha256']
        self.context.rollback(current)
        self.assertEqual(self.links(), {})
        self.assertIsNone(self.context.status()['current_sha256'])
        self.assertIsNone(self.context.status()['pending_sha256'])
        self.assertEqual(self.manager.reloads, 2)
        self.assert_refused_without_changes(lambda: self.context.rollback(current))

    def test_update_rollback_restores_previous_units_and_worker_consent(self):
        first = self.export(worker=True, allow_model_call=True)
        self.apply(first)
        previous = self.links()
        previous_current = self.context.status()['current_sha256']
        second = self.export(port=4132)
        self.apply(second)
        current = self.context.status()['current_sha256']
        self.assertNotEqual(current, previous_current)
        self.context.rollback(current)
        self.assertEqual(self.links(), previous)
        self.assert_installed(first)
        self.assertEqual(self.context.status()['current_sha256'], previous_current)
        self.assertEqual(self.manager.reloads, 3)

    def test_wrong_rollback_hash_changes_nothing(self):
        self.apply(self.export())
        self.assert_refused_without_changes(lambda: self.context.rollback('0' * 64))

    def test_stale_rollback_hash_cannot_remove_a_newer_install(self):
        self.apply(self.export())
        previous = self.context.status()['current_sha256']
        second = self.export(port=4132)
        self.apply(second)
        self.assert_refused_without_changes(lambda: self.context.rollback(previous))
        self.assert_installed(second)

    def test_manual_retargeting_prevents_rollback(self):
        self.apply(self.export())
        current = self.context.status()['current_sha256']
        path = self.units / s.CONSOLE
        path.unlink()
        path.symlink_to('/tmp/foreign-personal-console.service')
        self.assert_refused_without_changes(lambda: self.context.rollback(current))

    def test_failed_reload_restores_absence_and_clears_pending(self):
        pair = self.export()
        self.manager.fail_reloads = {1}
        with self.assertRaises(m.DeployError):
            self.apply(pair)
        self.assertEqual(self.links(), {})
        status = self.context.status()
        self.assertIsNone(status['current_sha256'])
        self.assertIsNone(status['pending_sha256'])
        self.assertEqual(self.manager.reloads, 2)
        self.manager.fail_reloads = set()
        self.apply(pair)
        self.assert_installed(pair)

    def test_failed_update_reload_restores_previous_generation(self):
        first = self.export(worker=True, allow_model_call=True)
        self.apply(first)
        previous = self.links()
        current = self.context.status()['current_sha256']
        self.manager.fail_reloads = {2}
        with self.assertRaises(m.DeployError):
            self.apply(self.export(port=4132))
        self.assertEqual(self.links(), previous)
        self.assertEqual(self.context.status()['current_sha256'], current)
        self.assertIsNone(self.context.status()['pending_sha256'])
        self.assert_installed(first)

    def test_pending_is_published_before_the_first_unit_change(self):
        pair = self.export()
        observed = []

        def inspect(label):
            if label == 'before_unit:' + m.PERSONAL_UNITS[0]:
                pending = self.home / 'personal-deployment/pending.json'
                observed.append(json.loads(pending.read_bytes()))
                self.assertEqual(pending.stat().st_mode & 0o777, 0o600)
                self.assertEqual(self.links(), {})

        reviewed = self.review(pair)
        self.context_with_fault(inspect).apply(
            pair[0], pair[1], pair[0]['plan_sha256'], reviewed['deployment_sha256'])
        self.assertEqual(len(observed), 1)
        self.assert_installed(pair)

    def test_crash_after_journal_blocks_apply_until_explicit_recovery(self):
        pair = self.export()
        reviewed = self.review(pair)
        pending = self.interrupt_apply(pair, 'after_journal')
        self.assertEqual(self.links(), {})
        self.assert_refused_without_changes(lambda: self.review(pair))
        self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))
        self.context.recover(pending)
        self.assertIsNone(self.context.status()['pending_sha256'])
        self.assertIsNone(self.context.status()['current_sha256'])
        self.apply(pair)
        self.assert_installed(pair)

    def test_crash_after_first_link_recovers_without_completing_install(self):
        pair = self.export()
        pending = self.interrupt_apply(pair, 'after_unit:' + m.PERSONAL_UNITS[0])
        self.assertEqual(len(self.links()), 1)
        self.context.recover(pending)
        self.assertEqual(self.links(), {})
        self.assertIsNone(self.context.status()['current_sha256'])
        self.assertIsNone(self.context.status()['pending_sha256'])

    def test_crash_after_current_commit_still_restores_recorded_before_state(self):
        first = self.export()
        self.apply(first)
        previous = self.links()
        current = self.context.status()['current_sha256']
        pending = self.interrupt_apply(self.export(port=4132), 'after_current')
        self.context.recover(pending)
        self.assertEqual(self.links(), previous)
        self.assertEqual(self.context.status()['current_sha256'], current)
        self.assertIsNone(self.context.status()['pending_sha256'])

    def test_crash_after_manager_reload_recovers_the_previous_generation(self):
        first = self.export()
        self.apply(first)
        previous = self.links()
        current = self.context.status()['current_sha256']
        pending = self.interrupt_apply(self.export(port=4132), 'after_reload')
        self.assertNotEqual(self.manager.rows[s.CONSOLE]['FragmentPath'], previous[s.CONSOLE])
        self.context.recover(pending)
        self.assertEqual(self.links(), previous)
        self.assertEqual(self.manager.rows[s.CONSOLE]['FragmentPath'], previous[s.CONSOLE])
        self.assertEqual(self.context.status()['current_sha256'], current)
        self.assertIsNone(self.context.status()['pending_sha256'])

    def test_interrupted_rollback_recovery_restores_before_rollback_state(self):
        self.apply(self.export())
        second = self.export(port=4132)
        self.apply(second)
        current = self.context.status()['current_sha256']
        previous = self.links()
        fired = []

        def interrupt(label):
            if label == 'after_unit:' + m.PERSONAL_UNITS[0]:
                fired.append(label)
                raise SimulatedPowerLoss('interrupted rollback')

        with self.assertRaises(SimulatedPowerLoss):
            self.context_with_fault(interrupt).rollback(current)
        self.assertEqual(fired, ['after_unit:' + m.PERSONAL_UNITS[0]])
        pending = self.context.status()['pending_sha256']
        self.assertIsInstance(pending, str)
        self.context.recover(pending)
        self.assertEqual(self.links(), previous)
        self.assertEqual(self.context.status()['current_sha256'], current)
        self.assertIsNone(self.context.status()['pending_sha256'])
        self.assert_installed(second)

    def test_wrong_pending_hash_and_repeated_recovery_are_refused(self):
        pending = self.interrupt_apply(self.export(), 'after_journal')
        self.assert_refused_without_changes(lambda: self.context.recover('0' * 64))
        self.context.recover(pending)
        self.assert_refused_without_changes(lambda: self.context.recover(pending))

    def test_recovery_reload_failure_preserves_pending_for_retry(self):
        pending = self.interrupt_apply(self.export(), 'after_unit:' + m.PERSONAL_UNITS[0])
        self.manager.fail_reloads = {1}
        with self.assertRaises(m.DeployError):
            self.context.recover(pending)
        self.assertEqual(self.context.status()['pending_sha256'], pending)
        self.assertTrue((self.home / 'personal-deployment/pending.json').exists())
        self.manager.fail_reloads = set()
        self.context.recover(pending)
        self.assertEqual(self.links(), {})
        self.assertIsNone(self.context.status()['pending_sha256'])

    def test_recovery_refuses_unknown_new_regular_unit(self):
        pending = self.interrupt_apply(self.export(), 'after_journal')
        (self.units / s.CONSOLE).write_text('manual unit written during crash\n')
        self.assert_refused_without_changes(lambda: self.context.recover(pending))

    def test_recovery_refuses_recreated_link_even_with_same_target(self):
        name = m.PERSONAL_UNITS[0]
        pending = self.interrupt_apply(self.export(), 'after_unit:' + name)
        path = self.units / name
        target = os.readlink(path)
        # Hold the original inode so the filesystem cannot recycle it immediately.
        original = self.units / 'saved-original-link'
        path.rename(original)
        path.symlink_to(target)
        self.assert_refused_without_changes(lambda: self.context.recover(pending))

    def test_another_data_home_cannot_ignore_shared_pending_transaction(self):
        pending = self.interrupt_apply(self.export(), 'after_journal')
        other_home = self.root / 'other-data'
        other_home.mkdir(mode=0o700)
        other = m.Context(other_home, user_home=self.account, manager=self.manager)
        value = s.plan(ROOT, other_home, '/usr/bin/bun')
        destination = self.root / 'other-export'
        s.export_plan(value, destination, value['plan_sha256'])
        self.assert_refused_without_changes(
            lambda: other.plan(value, destination, value['plan_sha256']))
        self.context.recover(pending)

    def test_crash_after_first_journal_publication_blocks_other_home_and_recovers(self):
        # Prepare another HOME's reviewed plan before A publishes any journal.
        # The same fixed unit names must remain reserved if A loses the process
        # between the coordinator publication and the local mirror publication.
        other_home = self.root / 'other-data-before-journal'
        other_home.mkdir(mode=0o700)
        other = m.Context(other_home, user_home=self.account, manager=self.manager)
        value = s.plan(ROOT, other_home, '/usr/bin/bun')
        destination = self.root / 'other-export-before-journal'
        s.export_plan(value, destination, value['plan_sha256'])
        other_reviewed = other.plan(value, destination, value['plan_sha256'])
        pair = self.export()
        reviewed = self.review(pair)
        original = self.context._atomic_new
        published = []

        def interrupt_first_publication(path, raw):
            original(path, raw)
            if path.name == 'pending.json':
                published.append(path)
                raise SimulatedPowerLoss('first pending journal published')

        with patch.object(self.context, '_atomic_new', side_effect=interrupt_first_publication):
            with self.assertRaises(SimulatedPowerLoss):
                self.apply(pair, reviewed)
        self.assertEqual(len(published), 1)
        self.assertEqual(self.links(), {})
        self.assertEqual(self.manager.reloads, 0)
        self.assert_refused_without_changes(
            lambda: other.plan(value, destination, value['plan_sha256']))
        self.assert_refused_without_changes(
            lambda: other.apply(value, destination, value['plan_sha256'],
                                other_reviewed['deployment_sha256']))
        self.assertEqual(published, [self.context.shared / 'pending.json'])
        self.assertFalse((self.context.state / 'pending.json').exists())
        pending = self.context.status()['pending_sha256']
        self.assertIsInstance(pending, str)
        self.assertEqual(len(pending), 64)
        recovered = self.context.recover(pending)
        self.assertIsNone(recovered['current_sha256'])
        self.assertIsNone(recovered['pending_sha256'])
        self.assertEqual(self.links(), {})
        self.assertFalse((self.context.shared / 'pending.json').exists())
        self.assertFalse((self.context.state / 'pending.json').exists())
        # After A's explicit recovery, the independent HOME may obtain a new
        # review and use the released names without adopting A's staged units.
        other_reviewed = other.plan(value, destination, value['plan_sha256'])
        result = other.apply(value, destination, value['plan_sha256'],
                             other_reviewed['deployment_sha256'])
        self.assertTrue(result['installed'])
        for target in self.links().values():
            self.assertTrue(Path(target).is_relative_to(other_home / 'personal-deployment'))

    def test_lock_contention_refuses_before_state_or_unit_mutation(self):
        pair = self.export()
        reviewed = self.review(pair)
        lock_dir = self.account / '.config/ultrabrain-personal-deployment'
        lock_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_path = lock_dir / 'lock'
        with lock_path.open('xb') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))

    def test_malformed_current_record_is_refused_without_repair(self):
        self.apply(self.export())
        current = self.home / 'personal-deployment/current.json'
        current.write_bytes(b'{this is not JSON}\n')
        self.assert_refused_without_changes(self.context.status)

    def test_oversized_current_record_is_refused_without_reading_unbounded_data(self):
        self.apply(self.export())
        current = self.home / 'personal-deployment/current.json'
        current.write_bytes(b' ' * (2 * 1024 * 1024))
        before = current.stat()
        original = os.read
        read_sizes = []

        def track_read(fd, count):
            raw = original(fd, count)
            observed = os.fstat(fd)
            if (observed.st_dev, observed.st_ino) == (before.st_dev, before.st_ino):
                read_sizes.append(len(raw))
            return raw

        with patch.object(os, 'read', side_effect=track_read):
            self.assert_refused_without_changes(self.context.status, 'state_file_too_large')
        self.assertEqual(read_sizes, [], 'reject oversized advertised size before reading')

    def test_symlinked_current_record_is_refused(self):
        self.apply(self.export())
        current = self.home / 'personal-deployment/current.json'
        foreign = self.root / 'current-copy.json'
        foreign.write_bytes(current.read_bytes())
        current.unlink()
        current.symlink_to(foreign)
        self.assert_refused_without_changes(self.context.status)

    def test_hardlinked_receipt_and_widened_permissions_are_refused(self):
        self.apply(self.export())
        current = self.context.status()['current_sha256']
        receipt = self.home / ('personal-deployment/receipts/' + current + '.json')
        copy_path = self.root / 'receipt-hardlink.json'
        os.link(receipt, copy_path)
        self.assert_refused_without_changes(self.context.status)
        copy_path.unlink()
        receipt.chmod(0o644)
        self.assert_refused_without_changes(self.context.status)

    def test_malformed_receipt_is_refused_without_replacing_it(self):
        self.apply(self.export())
        current = self.context.status()['current_sha256']
        receipt = self.home / ('personal-deployment/receipts/' + current + '.json')
        receipt.chmod(0o600)
        receipt.write_bytes(b'{"format":')
        self.assert_refused_without_changes(self.context.status)

    def test_current_record_unknown_keys_and_duplicate_keys_are_refused(self):
        self.apply(self.export())
        current = self.home / 'personal-deployment/current.json'
        original = current.read_bytes()
        value = json.loads(original)
        value['unreviewed'] = 'synthetic'
        current.write_text(json.dumps(value, sort_keys=True, ensure_ascii=True,
                                      separators=(',', ':')) + '\n')
        self.assert_refused_without_changes(self.context.status)
        decoded = json.loads(original)
        first = next(iter(decoded))
        duplicate = original.rstrip()[:-1] + b',' + json.dumps(first).encode() + b':' + \
            json.dumps(decoded[first], separators=(',', ':')).encode() + b'}\n'
        self.assertEqual(json.loads(duplicate), decoded)
        current.write_bytes(duplicate)
        self.assert_refused_without_changes(self.context.status)

    def test_generation_unit_edit_cannot_pass_status_or_rollback(self):
        self.apply(self.export())
        current = self.context.status()['current_sha256']
        deployed = Path(self.links()[s.CONSOLE])
        deployed.chmod(0o600)
        deployed.write_text('modified generation content\n')
        self.assert_refused_without_changes(self.context.status)
        self.assert_refused_without_changes(lambda: self.context.rollback(current))

    def test_extra_generation_file_invalidates_the_installed_inventory(self):
        self.apply(self.export())
        generation = Path(self.links()[s.CONSOLE]).parent
        generation.chmod(0o700)
        (generation / 'unreviewed.service').write_text('synthetic extra unit\n')
        self.assert_refused_without_changes(self.context.status)

    def test_generation_directory_symlink_replacement_is_refused(self):
        self.apply(self.export())
        generation = Path(self.links()[s.CONSOLE]).parent
        moved = self.root / 'moved-generation'
        generation.rename(moved)
        generation.symlink_to(moved, target_is_directory=True)
        self.assert_refused_without_changes(self.context.status)

    def test_corrupt_pending_record_cannot_trigger_recovery_writes(self):
        pending_hash = self.interrupt_apply(self.export(), 'after_journal')
        pending = self.home / 'personal-deployment/pending.json'
        pending.write_bytes(b'{invalid pending journal}\n')
        self.assert_refused_without_changes(lambda: self.context.recover(pending_hash))

    def test_pending_record_symlink_is_refused_without_following_external_data(self):
        pending_hash = self.interrupt_apply(self.export(), 'after_journal')
        pending = self.home / 'personal-deployment/pending.json'
        foreign = self.root / 'pending-copy.json'
        foreign.write_bytes(pending.read_bytes())
        pending.unlink()
        pending.symlink_to(foreign)
        self.assert_refused_without_changes(lambda: self.context.recover(pending_hash))

    def test_private_state_permissions_are_required_without_silent_repair(self):
        self.apply(self.export())
        state = self.home / 'personal-deployment'
        state.chmod(0o755)
        self.assert_refused_without_changes(self.context.status)

    def test_unit_directory_path_replacement_after_review_is_not_followed(self):
        pair = self.export()
        reviewed = self.review(pair)
        moved = self.root / 'moved-user-units'
        self.units.rename(moved)
        self.units.symlink_to(moved, target_is_directory=True)
        self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))

    def test_export_inventory_change_after_review_cannot_install(self):
        pair = self.export()
        reviewed = self.review(pair)
        (pair[1] / 'foreign.service').write_text('unreviewed extra unit\n')
        self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))

    def test_export_content_change_after_review_cannot_install(self):
        pair = self.export()
        reviewed = self.review(pair)
        (pair[1] / s.CONSOLE).write_text('changed after deployment plan review\n')
        self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))

    def test_export_symlink_replacement_after_review_cannot_install(self):
        pair = self.export()
        reviewed = self.review(pair)
        moved = self.root / 'moved-export'
        pair[1].rename(moved)
        pair[1].symlink_to(moved, target_is_directory=True)
        self.assert_refused_without_changes(lambda: self.apply(pair, reviewed))

    def test_unit_directory_replaced_during_transaction_is_not_populated(self):
        pair = self.export()
        reviewed = self.review(pair)
        moved = self.root / 'unit-directory-before-race'
        replaced = []

        def replace(label):
            if label == 'before_unit:' + m.PERSONAL_UNITS[0] and not replaced:
                self.units.rename(moved)
                self.units.mkdir(mode=0o700)
                replaced.append(label)

        with self.assertRaises(m.DeployError):
            self.context_with_fault(replace).apply(
                pair[0], pair[1], pair[0]['plan_sha256'], reviewed['deployment_sha256'])
        self.assertEqual(len(replaced), 1)
        self.assertEqual(os.listdir(self.units), [])
        # Keep journal-owned staging evidence in the moved original directory;
        # neither visible directory may acquire any of the public unit names.
        for name in m.PERSONAL_UNITS:
            self.assertFalse(os.path.lexists(moved / name))
        self.assertEqual(self.manager.reloads, 0)

    def test_export_race_while_verifying_cannot_create_unit_links(self):
        pair = self.export()
        reviewed = self.review(pair)
        exported_inodes = {(p.stat().st_dev, p.stat().st_ino)
                           for p in pair[1].iterdir()}
        original = os.read
        changed = []

        def add_unreviewed_file(fd, count):
            raw = original(fd, count)
            st = os.fstat(fd)
            if raw and not changed and (st.st_dev, st.st_ino) in exported_inodes:
                (pair[1] / 'added-during-read.service').write_text('unreviewed\n')
                changed.append(True)
            return raw

        with patch.object(os, 'read', side_effect=add_unreviewed_file):
            with self.assertRaises(m.DeployError):
                self.apply(pair, reviewed)
        self.assertEqual(changed, [True])
        self.assertEqual(self.links(), {})
        self.assertFalse((self.home / 'personal-deployment').exists())
        self.assertEqual(self.manager.reloads, 0)

    def test_cli_root_and_nonlinux_refuse_without_manager_or_file_mutation(self):
        for platform, uid in (('linux', 0), ('win32', 1001)):
            with self.subTest(platform=platform, uid=uid):
                before = tree_snapshot(self.root)
                with patch.object(m.sys, 'platform', platform), \
                        patch.object(m.os, 'geteuid', return_value=uid), \
                        patch.object(m, 'Context') as construct, \
                        contextlib.redirect_stdout(io.StringIO()) as output:
                    result = m.main(['status'])
                self.assertNotEqual(result, 0)
                self.assertIn('ordinary_linux_account_required', output.getvalue())
                construct.assert_not_called()
                self.assertEqual(tree_snapshot(self.root), before)


class TrustedSystemUnitPathTests(unittest.TestCase):
    """Synthetic ownership metadata for the one read-only distro alias policy.

    Temporary descriptors supply source/target contents; only this fixture
    substitutes root-owned metadata. It grants no production path exception.
    """

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='ub-system-unit-path-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'etc/xdg/systemd'
        self.target = self.root / 'etc/systemd/user'
        self.source.mkdir(parents=True, mode=0o700)
        self.target.mkdir(parents=True, mode=0o700)
        self.link = self.source / 'user'
        self.link.symlink_to('../../systemd/user', target_is_directory=True)
        self.official = Path('/etc/xdg/systemd/user')

    @staticmethod
    def metadata(value, **changes):
        fields = {name: getattr(value, name) for name in dir(value) if name.startswith('st_')}
        fields.update(changes)
        return SimpleNamespace(**fields)

    @contextlib.contextmanager
    def synthetic_alias(self, **link_metadata):
        original_stat = os.stat
        alias = self.link.lstat()
        self.opened = []

        def trusted_descriptor(path):
            path = Path(path)
            self.opened.append(path)
            mapped = {Path('/etc/xdg/systemd'): self.source,
                      Path('/etc/systemd/user'): self.target}[path]
            return os.open(mapped, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

        def synthetic_stat(path, *args, **kwargs):
            observed = original_stat(path, *args, **kwargs)
            if (observed.st_dev, observed.st_ino) == (alias.st_dev, alias.st_ino):
                values = {'st_uid': 0, **link_metadata}
                return self.metadata(observed, **values)
            return observed

        with patch.object(m.FS, 'open_trusted_system_directory', side_effect=trusted_descriptor), \
                patch.object(m.FS.os, 'stat', side_effect=synthetic_stat):
            yield

    def test_supported_relative_and_absolute_aliases_preserve_source_files(self):
        for raw_target in ('../../systemd/user', '/etc/systemd/user'):
            with self.subTest(raw_target=raw_target):
                self.link.unlink()
                self.link.symlink_to(raw_target, target_is_directory=True)
                before = tree_snapshot(self.root)
                with self.synthetic_alias():
                    resolved = m.FS.manager_scan_path(self.official)
                self.assertEqual(resolved, Path('/etc/systemd/user'))
                self.assertIn(Path('/etc/systemd/user'), self.opened)
                self.assertEqual(tree_snapshot(self.root), before)

    def test_forged_alias_owner_or_link_count_refuses_before_opening_target(self):
        for forged in ({'st_uid': 12345}, {'st_nlink': 2}):
            with self.subTest(forged=forged):
                before = tree_snapshot(self.root)
                with self.synthetic_alias(**forged), \
                        self.assertRaisesRegex(m.DeployError, 'untrusted_system_unit_alias'):
                    m.FS.manager_scan_path(self.official)
                self.assertNotIn(Path('/etc/systemd/user'), self.opened)
                self.assertEqual(tree_snapshot(self.root), before)

    def test_unapproved_alias_target_is_refused_without_resolving_it(self):
        for raw_target in ('/tmp/untrusted-user-units', '/etc/xdg/systemd/user',
                           '../../../home/untrusted/.config/systemd/user'):
            with self.subTest(raw_target=raw_target):
                self.link.unlink()
                self.link.symlink_to(raw_target, target_is_directory=True)
                before = tree_snapshot(self.root)
                with self.synthetic_alias(), \
                        self.assertRaisesRegex(m.DeployError, 'untrusted_system_unit_alias'):
                    m.FS.manager_scan_path(self.official)
                self.assertNotIn(Path('/etc/systemd/user'), self.opened)
                self.assertEqual(tree_snapshot(self.root), before)

    def test_source_and_destination_walks_refuse_untrusted_intermediate_parents(self):
        original_fstat = os.fstat
        for path in (self.source, self.target):
            parent = path.parent.stat()
            for forged in ({'st_uid': 12345}, {'writable': 0o020}, {'writable': 0o002}):
                with self.subTest(path=str(path.relative_to(self.root)), forged=forged):
                    def synthetic_fstat(fd):
                        observed = original_fstat(fd)
                        values = {'st_uid': 0, 'st_mode': observed.st_mode & ~0o022}
                        if (observed.st_dev, observed.st_ino) == (parent.st_dev, parent.st_ino):
                            if 'st_uid' in forged:
                                values['st_uid'] = forged['st_uid']
                            else:
                                values['st_mode'] |= forged['writable']
                        return self.metadata(observed, **values)

                    before = tree_snapshot(self.root)
                    with patch.object(m.FS.os, 'fstat', side_effect=synthetic_fstat), \
                            self.assertRaisesRegex(m.DeployError, 'untrusted_system_unit_path'):
                        m.FS.open_trusted_system_directory(path)
                    self.assertEqual(tree_snapshot(self.root), before)

    def test_alias_replacement_during_read_is_refused(self):
        original_readlink = os.readlink
        replaced = []

        def replace_during_read(path, *args, **kwargs):
            result = original_readlink(path, *args, **kwargs)
            if path == 'user' and not replaced:
                self.link.rename(self.source / 'preserved-original-user-link')
                self.link.symlink_to('../../systemd/user', target_is_directory=True)
                replaced.append(True)
            return result

        with self.synthetic_alias(), patch.object(m.FS.os, 'readlink', side_effect=replace_during_read), \
                self.assertRaisesRegex(m.DeployError, 'system_unit_alias_changed'):
            m.FS.manager_scan_path(self.official)
        self.assertEqual(replaced, [True])


class ProductionManagerBoundaryTests(unittest.TestCase):
    """Production parser and bounded child runner; never launch systemctl here."""

    @staticmethod
    def records():
        return {name: FixtureManager.absent(name) for name in m.PERSONAL_UNITS}

    @staticmethod
    def wire(rows):
        return ('\n\n'.join('\n'.join(key + '=' + value for key, value in row.items())
                           for row in rows.values()) + '\n').encode()

    def parse(self, rows=None, *, raw=None, exitcode=5):
        manager = m.LocalManager()
        responses = [(0, b'UnitPath=/tmp/fixture-user-units /usr/lib/systemd/user\n'),
                     (exitcode, raw if raw is not None else self.wire(rows or self.records()))]
        with patch.object(m, 'run_manager', side_effect=responses) as run:
            result = manager('show')
        return result, manager, run.call_args_list

    def test_production_parser_accepts_complete_absence_and_empty_job_with_exit_five(self):
        rows, manager, calls = self.parse()
        self.assertEqual(rows, self.records())
        self.assertEqual(manager.unit_paths,
                         (Path('/tmp/fixture-user-units'), Path('/usr/lib/systemd/user')))
        self.assertEqual(calls[0].args[0], ['--all', '--property=UnitPath', 'show'])
        self.assertEqual(calls[1].args[0][-4:], ['--', *m.PERSONAL_UNITS])
        self.assertEqual(calls[1].args[0][1], '--property=' + ','.join(m.PROPERTIES))

    def test_production_parser_rejects_duplicate_missing_and_foreign_records(self):
        rows = self.records()
        wire = self.wire(rows)
        missing = dict(rows)
        missing.pop(s.WORKER)
        foreign = copy.deepcopy(rows)
        foreign[s.CONSOLE]['Id'] = 'foreign.service'
        for raw in (wire.replace(b'LoadState=', b'Id=' + s.CONSOLE.encode() + b'\nLoadState=', 1),
                    self.wire(missing), self.wire(foreign),
                    wire + b'\n' + self.wire({s.TARGET: rows[s.TARGET]})):
            with self.subTest(raw_length=len(raw)), self.assertRaises(m.DeployError):
                self.parse(raw=raw)

    def test_production_parser_rejects_invalid_property_output_and_unknown_exitcode(self):
        wire = self.wire(self.records())
        for raw in (wire.replace(b'Job=\n', b'', 1),
                    wire.replace(b'Job=\n', b'Environment=PRIVATE\nJob=\n', 1),
                    b'\xff', b'\x00', b'x' * 65537):
            with self.subTest(raw_length=len(raw)), self.assertRaises(m.DeployError):
                self.parse(raw=raw)
        with self.assertRaises(m.DeployError):
            self.parse(exitcode=124)

    def test_manager_environment_pins_local_bus_and_ignores_ambient_injection(self):
        secret = 'SYNTHETIC_DEPLOY_MANAGER_SECRET'
        with patch.dict(os.environ, {
                'HOME': '/tmp/untrusted-account',
                'DBUS_SESSION_BUS_ADDRESS': 'tcp:host=untrusted.invalid',
                'XDG_RUNTIME_DIR': '/tmp/untrusted-runtime',
                'SYSTEMD_UNIT_PATH': '/tmp/untrusted-units',
                'SYSTEMD_HOST': 'untrusted.invalid', 'LD_PRELOAD': '/tmp/untrusted.so',
                'PYTHONPATH': '/tmp/untrusted-python', 'OPENAI_API_KEY': secret}):
            environment = m.manager_environment()
        encoded = json.dumps(environment)
        self.assertNotIn('untrusted', encoded)
        self.assertNotIn(secret, encoded)
        self.assertEqual(environment['DBUS_SESSION_BUS_ADDRESS'],
                         'unix:path=/run/user/' + str(os.geteuid()) + '/bus')
        self.assertEqual(environment['XDG_RUNTIME_DIR'], '/run/user/' + str(os.geteuid()))
        self.assertEqual(environment['PATH'], '/usr/bin:/bin')
        self.assertNotIn('SYSTEMD_HOST', environment)
        self.assertNotIn('SYSTEMD_UNIT_PATH', environment)
        self.assertNotIn('LD_PRELOAD', environment)

    def invoke_child(self, program, **options):
        actual_popen = subprocess.Popen
        self.children = []
        self.commands = []

        def launch(command, **kwargs):
            self.commands.append(command)
            child = actual_popen([sys.executable, '-I', '-c', program], **kwargs)
            self.children.append(child)
            return child

        with patch.object(m.subprocess, 'Popen', side_effect=launch):
            return m.run_manager(['show'], **options)

    def test_bounded_runner_uses_fixed_local_command_and_discards_stderr(self):
        code, raw = self.invoke_child('import sys;print("fixture");'
                                     'print("PRIVATE STDERR",file=sys.stderr);sys.exit(5)')
        self.assertEqual((code, raw), (5, b'fixture\n'))
        self.assertEqual(self.commands, [
            ['/usr/bin/systemctl', '--user', '--no-pager', '--no-ask-password', 'show']])
        self.assertIsNotNone(self.children[0].returncode)
        self.assertTrue(self.children[0].stdout.closed)
        self.assertTrue(self.children[0].stderr.closed)

    def test_bounded_runner_limits_both_stdout_and_discarded_stderr(self):
        for descriptor in (1, 2):
            with self.subTest(descriptor=descriptor):
                with self.assertRaisesRegex(m.DeployError, 'manager_output_limit'):
                    self.invoke_child('import os;os.write(' + str(descriptor) + ',b"x"*32768)',
                                      limit=64)
                self.assertIsNotNone(self.children[0].returncode)
                self.assertTrue(self.children[0].stdout.closed)
                self.assertTrue(self.children[0].stderr.closed)

    def test_bounded_runner_timeout_terminates_and_reaps_its_child(self):
        started = time.monotonic()
        with patch.object(m.os, 'killpg', wraps=os.killpg) as terminate:
            with self.assertRaisesRegex(m.DeployError, 'manager_timeout'):
                self.invoke_child('import time;time.sleep(30)', timeout=0.15)
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual(terminate.call_count, 1)
        self.assertEqual(terminate.call_args.args[0], self.children[0].pid)
        self.assertIsNotNone(self.children[0].returncode)
        self.assertTrue(self.children[0].stdout.closed)
        self.assertTrue(self.children[0].stderr.closed)


if __name__ == '__main__':
    unittest.main()
