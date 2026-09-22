"""Regression for Codex review 5255138559 / comment 4052688941.

Synthetic, private fixture files; actual public CLI, no service/database calls.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recovery_init_fixture', ROOT/'test/test_personal_init.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
m = fixture.m


class StatusRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.InitializationTests()
        self.addCleanup(self.case.doCleanups)
        self.case.setUp()

    def assert_status_recovery(self):
        before = self.case.snapshot()
        code, value = self.case.cli('status')
        self.assertEqual(code, 1)
        self.assertEqual(value.get('error'), 'token_recovery_required')
        self.assertFalse(value['ok'])
        self.assertEqual(value['token_creation'], 'not_proven')
        self.assertNotIn('SYNTHETIC', json.dumps(value))
        self.assertFalse(self.case.token.exists())
        self.assertEqual(self.case.snapshot(), before)

    def test_public_status_distinguishes_missing_deployed_credential_from_first_run(self):
        for name in ('personal-deployment', 'personal-activation'):
            with self.subTest(history=name):
                history = self.case.home/name
                history.mkdir(mode=0o700)
                original = history.stat()
                try:
                    self.assert_status_recovery()
                    current = history.stat()
                    self.assertEqual((current.st_ino, current.st_mode, current.st_mtime_ns),
                                     (original.st_ino, original.st_mode, original.st_mtime_ns))
                    self.assertEqual(list(history.iterdir()), [])
                finally:
                    history.rmdir()

    def test_status_rejects_linked_corrupt_and_fifo_history_without_opening_it(self):
        for name in ('personal-deployment', 'personal-activation'):
            for kind in ('dangling_link', 'corrupt_file', 'fifo'):
                with self.subTest(history=name, kind=kind):
                    history = self.case.home/name
                    if kind == 'dangling_link':
                        history.symlink_to(self.case.base/'never-created')
                    elif kind == 'corrupt_file':
                        history.write_bytes(b'SYNTHETIC_HISTORY_NOT_JSON')
                    else:
                        os.mkfifo(history, 0o600)
                    before = history.lstat()
                    try:
                        self.assert_status_recovery()
                        after = history.lstat()
                        self.assertEqual((after.st_ino, after.st_mode, after.st_size),
                                         (before.st_ino, before.st_mode, before.st_size))
                    finally:
                        history.unlink()

    def test_status_history_check_neither_generates_random_bytes_nor_creates_files(self):
        (self.case.home/'personal-deployment').mkdir(mode=0o700)
        original_open = m.os.open
        def readonly(path, flags, *args, **kwargs):
            self.assertFalse(flags & (os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_RDWR))
            return original_open(path, flags, *args, **kwargs)
        with patch.object(m.secrets, 'token_hex', side_effect=AssertionError('No generation')), \
             patch.object(m.os, 'open', side_effect=readonly):
            with self.assertRaisesRegex(m.PREFLIGHT.PreflightError, 'token_recovery_required'):
                self.case.run_init('status')
        self.assertFalse(self.case.token.exists())

    def test_existing_valid_deployed_credential_remains_readable_and_unchanged(self):
        self.case.put(m.TOKEN, b'c'*64+b'\n')
        for name in ('personal-deployment', 'personal-activation'):
            (self.case.home/name).mkdir(mode=0o700)
        before = self.case.snapshot()
        inode = self.case.token.stat().st_ino
        for action in ('status', 'create-token'):
            code, value = self.case.cli(action)
            self.assertEqual(code, 0)
            self.assertEqual(value['token_creation'], 'existing')
            self.assertEqual(self.case.snapshot(), before)
            self.assertEqual(self.case.token.stat().st_ino, inode)

    def test_optimized_public_status_also_requires_recovery(self):
        (self.case.home/'personal-activation').mkdir(mode=0o700)
        child = subprocess.run(['/usr/bin/python3', '-I', '-B', '-OO',
            str(ROOT/'scripts/personal-init.py'), 'status', '--home', str(self.case.home)],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(child.returncode, 1)
        self.assertEqual(child.stderr, '')
        self.assertEqual(json.loads(child.stdout).get('error'), 'token_recovery_required')
        self.assertFalse(self.case.token.exists())


if __name__ == '__main__':
    unittest.main()
