"""Adversarial export checks using synthetic private directories, never user units."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('guardrail_services', ROOT/'scripts/personal-services.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class PersonalServicesGuardrails(unittest.TestCase):
    def setUp(self):
        mask = os.umask(0o077)
        self.addCleanup(os.umask, mask)
        tmp = tempfile.TemporaryDirectory(prefix='ub-services-guardrails-')
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.value = m.plan(ROOT, self.root/'data', '/usr/bin/bun')
        self.output = self.root/'export'

    def do_export(self):
        return m.export_plan(self.value, self.output, self.value['plan_sha256'])

    def test_export_cannot_install_into_xdg_unit_search_directory(self):
        config = self.root/'config'
        (config/'systemd').mkdir(parents=True, mode=0o700)
        self.output = config/'systemd/user'
        with patch.dict(os.environ, {'XDG_CONFIG_HOME': str(config)}):
            with self.assertRaisesRegex(m.ServicePlanError, 'unit_search_path'):
                self.do_export()
        self.assertFalse(self.output.exists())

    def test_export_cannot_install_into_explicit_unit_path(self):
        self.output = self.root/'custom-unit-search'
        with patch.dict(os.environ, {'SYSTEMD_UNIT_PATH': str(self.output)+':'}):
            with self.assertRaisesRegex(m.ServicePlanError, 'unit_search_path'):
                self.do_export()
        self.assertFalse(self.output.exists())

    def test_export_cannot_install_into_runtime_generator_path(self):
        runtime = self.root/'runtime'
        (runtime/'systemd').mkdir(parents=True, mode=0o700)
        self.output = runtime/'systemd/generator'
        with patch.dict(os.environ, {'XDG_RUNTIME_DIR': str(runtime)}):
            with self.assertRaisesRegex(m.ServicePlanError, 'unit_search_path'):
                self.do_export()
        self.assertFalse(self.output.exists())

    def test_verify_rechecks_inventory_after_reading(self):
        self.do_export()
        original = m.os.read
        triggered = False
        def add_file(fd, count):
            nonlocal triggered
            raw = original(fd, count)
            if not triggered and raw:
                triggered = True
                (self.output/'unreviewed.service').write_text('[Service]\nExecStart=/bin/true\n')
            return raw
        with patch.object(m.os, 'read', side_effect=add_file):
            with self.assertRaisesRegex(m.ServicePlanError, 'export_inventory_changed'):
                m.verify_export(self.value, self.output, self.value['plan_sha256'])
        self.assertTrue(triggered)

    def test_export_rechecks_each_published_unit_before_success(self):
        original = m.write_file
        def tamper(fd, name, raw):
            original(fd, name, raw)
            if name == 'manifest.json':
                (self.output/m.CONSOLE).write_text('changed after write and before publication\n')
        with patch.object(m, 'write_file', side_effect=tamper):
            with self.assertRaisesRegex(m.ServicePlanError, 'export_content_mismatch'):
                self.do_export()
        self.assertTrue((self.output/'INCOMPLETE').exists())

    def test_home_data_and_shared_xdg_unit_directories_refused(self):
        from types import SimpleNamespace
        with patch.object(m.Path, 'home', return_value=self.root/'home'), \
             patch('pwd.getpwuid', return_value=SimpleNamespace(pw_dir=str(self.root/'account-home'))):
            for root in (self.root/'home/.config/systemd/user',
                         self.root/'account-home/.local/share/systemd/user'):
                with self.subTest(path=root):
                    with self.assertRaisesRegex(m.ServicePlanError, 'unit_search_path'):
                        m.reject_unit_search_path(root)
        for key in ('XDG_DATA_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS'):
            with self.subTest(key=key), patch.dict(os.environ, {key:str(self.root/'custom')}):
                with self.assertRaisesRegex(m.ServicePlanError, 'unit_search_path'):
                    m.reject_unit_search_path(self.root/'custom/systemd/user')

    def test_custom_path_subdirectories_refused_but_similar_prefix_allowed(self):
        custom = self.root/'units'
        with patch.dict(os.environ, {'SYSTEMD_UNIT_PATH':str(custom)}):
            with self.assertRaisesRegex(m.ServicePlanError, 'unit_search_path'):
                m.reject_unit_search_path(custom/'nested')
            m.reject_unit_search_path(self.root/'units-backup')

    def test_invalid_or_oversized_search_environment_fails_before_output(self):
        for value in ('relative/path', '/a\nb', '/'+'x'*32768):
            with self.subTest(value_length=len(value)), patch.dict(os.environ, {'SYSTEMD_UNIT_PATH':value}):
                with self.assertRaisesRegex(m.ServicePlanError, 'invalid_unit_search_path'):
                    self.do_export()
            self.assertFalse(self.output.exists())

    def test_same_size_export_tampering_is_detected_before_completion(self):
        original = m.write_file
        def tamper(fd, name, raw):
            original(fd, name, raw)
            if name == 'manifest.json':
                path = self.output/m.CONSOLE
                content = path.read_bytes()
                path.write_bytes(b'#'+content[1:])
        with patch.object(m, 'write_file', side_effect=tamper):
            with self.assertRaisesRegex(m.ServicePlanError, 'export_content_mismatch'):
                self.do_export()
        self.assertTrue((self.output/'INCOMPLETE').exists())

    def test_transient_inventory_mutation_is_not_a_verified_snapshot(self):
        self.do_export()
        original = m.os.read
        touched = False
        def transient(fd, count):
            nonlocal touched
            raw = original(fd, count)
            if raw and not touched:
                touched = True
                path = self.output/'temporary-extra'
                path.write_text('synthetic')
                path.unlink()
            return raw
        with patch.object(m.os, 'read', side_effect=transient):
            with self.assertRaisesRegex(m.ServicePlanError, 'export_inventory_changed'):
                m.verify_export(self.value, self.output, self.value['plan_sha256'])
        self.assertTrue(touched)

    def test_unit_search_alias_to_new_export_is_refused(self):
        alias = self.root/'unit-path-alias'
        alias.symlink_to(self.output, target_is_directory=True)
        with patch.dict(os.environ, {'SYSTEMD_UNIT_PATH':str(alias)}):
            with self.assertRaisesRegex(m.ServicePlanError, 'unit_search_path'):
                self.do_export()
        self.assertFalse(self.output.exists())

    def test_later_read_cannot_hide_rewrite_of_an_already_checked_unit(self):
        self.do_export()
        original = m.os.read
        triggered = False
        first = self.output / m.TARGET
        metadata = os.stat(first)
        def change_previous(fd, count):
            nonlocal triggered
            raw = original(fd, count)
            if raw and not triggered and os.fstat(fd).st_ino != metadata.st_ino:
                triggered = True
                first.write_bytes(b"#" + first.read_bytes()[1:])
            return raw
        with patch.object(m.os, 'read', side_effect=change_previous):
            with self.assertRaisesRegex(m.ServicePlanError, 'export_content_changed'):
                m.verify_export(self.value, self.output, self.value['plan_sha256'])
        self.assertTrue(triggered)

    def test_later_read_cannot_hide_permission_widening_of_checked_unit(self):
        self.do_export()
        original = m.os.read
        changed = False
        first = self.output / m.TARGET
        metadata = os.stat(first)
        def widen_previous(fd, count):
            nonlocal changed
            raw = original(fd, count)
            if raw and not changed and os.fstat(fd).st_ino != metadata.st_ino:
                changed = True
                first.chmod(0o644)
            return raw
        with patch.object(m.os, 'read', side_effect=widen_previous):
            with self.assertRaisesRegex(m.ServicePlanError, 'export_content_changed'):
                m.verify_export(self.value, self.output, self.value['plan_sha256'])
        self.assertTrue(changed)

if __name__ == '__main__':
    unittest.main()
