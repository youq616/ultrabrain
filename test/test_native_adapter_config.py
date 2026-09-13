import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_config', ROOT / 'scripts/native-adapter-config.py')
config = importlib.util.module_from_spec(spec); spec.loader.exec_module(config)


class NativeAdapterConfigTests(unittest.TestCase):
    def test_opencode_factory_quotes_paths_without_shell(self):
        p = Path('/private/p "quote".json')
        result = config.patch('opencode-native', None, p, Path('/private/native-adapters.cjs'), None, None)
        self.assertIn(b'export default createOpenCodePlugin', result)
        self.assertIn(json.dumps(str(p)).encode(), result)
        with self.assertRaises(config.io.ConfigError):
            config.patch('opencode-native', b'// my existing plugin', p, Path('/private/library'), None, None)

    def test_openclaw_keeps_memory_slot_permissions_and_other_plugins(self):
        base = {'plugins': {'slots': {'memory': 'memory-core'}, 'allow': ['existing'], 'entries': {'existing': {'enabled': True}}}, 'tools': {'deny': ['exec']}}
        raw = json.dumps(base).encode()
        output = config.patch('openclaw-native', raw, Path('/private/p'), Path('/package/dist/native-adapters.cjs'), None, None, ['mine'], ['private'])
        after = json.loads(output)
        self.assertEqual(after['plugins']['slots'], base['plugins']['slots'])
        self.assertEqual(after['tools'], base['tools'])
        self.assertEqual(after['plugins']['allow'], ['existing', 'ultrabrain-personal'])
        self.assertEqual(after['plugins']['load']['paths'], [str(Path('/package'))])
        self.assertEqual(config.patch('openclaw-native', output, Path('/private/p'), Path('/package/dist/native-adapters.cjs'), None, None, ['mine'], ['private']), output)

    def test_never_enables_global_disabled_or_explicitly_denied_plugin(self):
        for value in [{'plugins': {'enabled': False}}, {'plugins': {'deny': ['ultrabrain-personal']}}, {'plugins': {'entries': {'ultrabrain-personal': {'enabled': False}}}}]:
            with self.assertRaises(config.io.ConfigError):
                config.patch('openclaw-native', json.dumps(value).encode(), Path('/p'), Path('/package/dist/native-adapters.cjs'), None, None, ['mine'], ['private'])

    def test_openclaw_refuses_empty_wildcard_and_control_character_sessions(self):
        for sessions in ([], ['*'], ['x\n'], ['a'] * 33):
            with self.assertRaises(config.io.ConfigError):
                config.patch('openclaw-native', None, Path('/p'), Path('/pkg/dist/native-adapters.cjs'), None, None, ['mine'], sessions)

    def test_hermes_config_is_separate_from_core_yaml_or_existing_provider(self):
        raw = config.patch('hermes-native', None, Path('/p'), None, Path('/node'), Path('/cli'))
        self.assertEqual(set(json.loads(raw)), {'format', 'node', 'cli', 'profile'})
        with self.assertRaises(config.io.ConfigError):
            config.patch('hermes-native', b'{"existing":"keep"}', Path('/p'), None, Path('/node'), Path('/cli'))

    def test_actual_plan_apply_rollback_requires_pins_and_keeps_user_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); profile = root / 'profile.json'; library = root / 'native-adapters.cjs'; target = root / 'plugin.js'
            p = {'format': 1, 'workspace': directory, 'expected_instance': '00000000-0000-4000-8000-000000000001', 'expected_actor': 'a' * 64}
            profile.write_text(json.dumps(p)); library.write_text('// fixture')
            for path in (profile, library): path.chmod(0o600)
            args = ['--client', 'opencode-native', '--target', str(target), '--profile', str(profile), '--library', str(library)]
            self.assertEqual(config.main(args), 0); self.assertFalse(target.exists())
            self.assertEqual(config.main(args + ['--apply', '--expected-sha', 'absent']), 0)
            receipt = next(root.glob('*.receipt.json'))
            target.write_text('new user edit')
            self.assertEqual(config.main(['--target', str(target), '--rollback', str(receipt)]), 1)
            self.assertEqual(target.read_text(), 'new user edit')
