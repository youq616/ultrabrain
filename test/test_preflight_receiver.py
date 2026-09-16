"""Receiver self-review regressions; no claim of a separate reviewer agent."""
import contextlib
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import test_preflight as fixtures
m = fixtures.m

class ReceiverPreflightTests(unittest.TestCase):
    def fixture(self):
        f = fixtures.PreflightTests(); f.setUp(); self.addCleanup(f.doCleanups)
        f.mock_probe.stop(); f.mock_which.stop()
        tools = f.base/'tools'; tools.mkdir(mode=0o700)
        for name in ('bun', *m.BUILD_TOOLS):
            p = tools/name
            p.write_text('#!/bin/sh\n' + ('printf "1.3.13\\n"\n' if name == 'bun' else 'exit 0\n'))
            p.chmod(0o700)
        return f, tools
    def test_relative_bun_path_keeps_the_dependency_selected_by_which(self):
        f, tools = self.fixture()
        original = os.getcwd()
        try:
            os.chdir(f.base)
            with patch.dict(os.environ, {'PATH': 'tools'}):
                r = f.run_check('runtime')
            self.assertTrue(r['ok'], r['checks'])
        finally:
            os.chdir(original)
    def test_relative_pkg_config_path_is_not_rebased_to_root(self):
        f, tools = self.fixture()
        original = os.getcwd()
        try:
            os.chdir(f.base)
            with patch.object(m.shutil, 'which', side_effect=lambda name:
                              'tools/pkg-config' if name == 'pkg-config' else str(tools/name)):
                r = f.run_check('install')
            self.assertTrue(r['ok'], r['checks'])
        finally:
            os.chdir(original)

if __name__ == '__main__':
    unittest.main()
