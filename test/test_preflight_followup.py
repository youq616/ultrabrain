"""Reproduce separate-review findings without ever touching a live installation."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch
import test_preflight as fixtures
m = fixtures.m
ROOT = Path(__file__).resolve().parents[1]

class PreflightReviewFollowupTests(unittest.TestCase):
    def fixture(self):
        f = fixtures.PreflightTests(); f.setUp(); self.addCleanup(f.doCleanups)
        return f
    def replace_postgres(self, f):
        saved = f.base / 'old-postgres'
        (f.home / 'postgres').rename(saved)
        shutil.copytree(saved, f.home / 'postgres')
        f.put('postgres/state.json', json.dumps({**f.state, 'port': 7654}).encode())
    def test_ancestor_swap_during_state_read_is_not_a_valid_installation(self):
        f = self.fixture(); original = os.read; old_inode = (f.home/'postgres/state.json').stat().st_ino
        changed = False
        def read(fd, count):
            nonlocal changed
            raw = original(fd, count)
            if os.fstat(fd).st_ino == old_inode and not changed:
                changed = True; self.replace_postgres(f)
            return raw
        with patch.object(m.os, 'read', side_effect=read):
            result = f.run_check()
        self.assertTrue(changed)
        self.assertFalse(result['ok'])
        self.assertEqual(f.item(result, 'database_state')['code'], 'managed_path_changed_during_check')
    def test_state_path_replacement_after_read_is_caught_at_report_end(self):
        f = self.fixture(); original = m.validate_state
        def checked(value):
            result = original(value)
            self.replace_postgres(f)
            return result
        with patch.object(m, 'validate_state', side_effect=checked):
            result = f.run_check()
        self.assertFalse(result['ok'])
        self.assertEqual(f.item(result, 'home_unchanged')['code'], 'managed_path_changed_during_check')
    def test_home_permissions_changed_during_probe_fail_closed(self):
        f = self.fixture()
        def changed(args):
            f.home.chmod(0o755)
            return b'1.3.13\n'
        with patch.object(m, 'run_local', side_effect=changed):
            result = f.run_check()
        self.assertFalse(result['ok'])
        self.assertEqual(f.item(result, 'home_unchanged')['code'], 'owner_only_permissions_required')
    def guard_probe(self, *, flags=(), consent=False, uid=12345, env_optimized=False):
        # The mocked first private read exits97. It must never be reached, even
        # when Python strips assertions. No PostgreSQL, service or chmod executes.
        code = '''import runpy
from unittest.mock import patch

def accessed(*args, **kwargs):
    raise SystemExit(97)
with patch('pathlib.Path.read_bytes', side_effect=accessed), patch('os.geteuid', return_value=UID), patch('shutil.which', return_value='/synthetic/bun'):
    runpy.run_path(TARGET, run_name='__main__')
'''.replace('UID', str(uid)).replace('TARGET', repr(str(ROOT/'test/preflight-integration.py')))
        env = dict(os.environ)
        env.pop('PYTHONOPTIMIZE', None)
        env.pop('ULTRABRAIN_TEST_ALLOW_WRITE', None)
        env['ULTRABRAIN_HOME'] = '/not-a-live-installation'
        if consent:
            env['ULTRABRAIN_TEST_ALLOW_WRITE'] = '1'
        if env_optimized:
            env['PYTHONOPTIMIZE'] = '1'
        result = subprocess.run([sys.executable, '-B', *flags, '-c', code], env=env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1, 'Safety gate must exit before the mocked private read')
        self.assertNotIn('Traceback', result.stderr)
        self.assertEqual(result.stdout, '')
    def test_integration_consent_survives_dash_O(self):
        self.guard_probe(flags=('-O',))
    def test_integration_consent_survives_dash_OO(self):
        self.guard_probe(flags=('-OO',))
    def test_integration_consent_survives_PYTHONOPTIMIZE(self):
        self.guard_probe(env_optimized=True)
    def test_integration_root_refusal_survives_optimization(self):
        self.guard_probe(flags=('-O',), consent=True, uid=0)
    def test_integration_refuses_disabled_assertions_even_with_consent(self):
        self.guard_probe(flags=('-O',), consent=True)

if __name__ == '__main__':
    unittest.main()
