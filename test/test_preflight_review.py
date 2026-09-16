"""Adversarial second-pass regressions. These do not constitute an independent agent review."""
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import test_preflight as fixtures
m = fixtures.m

class PreflightReviewTests(unittest.TestCase):
    def fixture(self):
        value=fixtures.PreflightTests();value.setUp();self.addCleanup(value.doCleanups);return value
    def test_install_parent_must_be_writable_without_a_write_probe(self):
        f=self.fixture();parent=f.base/'readonly';parent.mkdir(mode=0o500)
        try:
            r=f.run_check('install',parent/'future-home');self.assertFalse(r['ok'])
            self.assertFalse((parent/'future-home').exists())
        finally:parent.chmod(0o700)
    def test_dependency_directory_must_not_be_an_ordinary_file(self):
        f=self.fixture();p=f.repo/'vendor/gbrain/node_modules';p.rmdir();p.write_bytes(b'not a directory')
        self.assertFalse(f.run_check()['ok'])
    def test_source_entrypoint_cannot_be_a_directory(self):
        f=self.fixture();p=f.repo/'vendor/gbrain/src/cli.ts';p.unlink();p.mkdir(mode=0o700)
        self.assertFalse(f.run_check()['ok'])
    def test_source_directory_link_not_trusted_as_a_checkout(self):
        f=self.fixture();p=f.repo/'vendor/gbrain/node_modules';p.rmdir();p.symlink_to(f.base,target_is_directory=True)
        self.assertFalse(f.run_check()['ok'])
    def test_completed_reaped_probe_does_not_kill_a_potentially_reused_pid(self):
        # Stop fixture's probe mock; this runs the actual bounded child wrapper.
        with patch.object(m.os,'killpg', wraps=os.killpg) as kill:
            self.assertEqual(m.run_local([sys.executable,'-c','print("done")']),b'done\n')
            kill.assert_not_called()
    def test_cli_null_home_not_silently_replaced_by_real_user_profile(self):
        stream=io.StringIO()
        with patch.dict(os.environ,{'ULTRABRAIN_HOME':''}),contextlib.redirect_stdout(stream):
            code=m.main([])
        self.assertNotEqual(code,0);self.assertNotIn(str(Path.home()),stream.getvalue())

if __name__=='__main__':unittest.main()
