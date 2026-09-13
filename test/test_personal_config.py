"""Synthetic private configuration tests; no provider calls, keys or real user config."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('personal_config', ROOT / 'scripts/configure-personal-model.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PersonalConfigTests(unittest.TestCase):
    def test_separate_profile_and_private_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'config.json'
            original = {'chat_model': 'fixture:model', 'ultrabrain_semantics': {'enabled': False}, 'engine': 'postgres'}
            p.write_text(json.dumps(original))
            p.chmod(0o600)
            report = module.configure(p, from_chat=True, revision='test-1')
            result = json.loads(p.read_text())
            self.assertTrue(result['ultrabrain_personal_consolidation']['enabled'])
            self.assertFalse(result['ultrabrain_semantics']['enabled'])
            self.assertEqual(report['model_calls'], 0)
            backups = list(Path(folder).glob('config.before-personal-*'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(json.loads(backups[0].read_text()), original)
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
    def test_disable_preserves_other_provider_config(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'config.json'
            p.write_text('{"chat_model":"fixture:model"}')
            p.chmod(0o600)
            module.configure(p, disable=True)
            result = json.loads(p.read_text())
            self.assertEqual(result['chat_model'], 'fixture:model')
            self.assertFalse(result['ultrabrain_personal_consolidation']['enabled'])
    def test_invalid_and_nonprivate_config_is_not_modified(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'config.json'
            p.write_text('{}')
            p.chmod(0o600)
            for options in ({'model':'https://not-a-model','revision':'x'}, {'model':'fixture:model'}, {'from_chat':True,'revision':'x'}):
                with self.assertRaises(RuntimeError):
                    module.configure(p, **options)
                self.assertEqual(p.read_text(), '{}')
            p.chmod(0o644)
            with self.assertRaises(RuntimeError):
                module.configure(p, disable=True)
    def test_symlink_config_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'config.json'
            p.write_text('{}')
            p.chmod(0o600)
            link = Path(folder) / 'alias'
            link.symlink_to(p)
            with self.assertRaises(RuntimeError):
                module.configure(link, disable=True)
