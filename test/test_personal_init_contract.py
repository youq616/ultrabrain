"""Cross-stage credential contract: actual initializer CLI and activation planner.

All credentials/configuration are synthetic and disposable. Activation uses the
existing fixture manager/procfs; it never starts a service or connects a database.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


init_fixture = load('init_contract_fixture', ROOT/'test/test_personal_init.py')
activation_fixture = load('init_contract_activation', ROOT/'test/test_personal_activate.py')
m = init_fixture.m
TOKEN = b'a' * 64  # Synthetic fixture, never an operator credential.
INVALID_WHITESPACE = (b' '+TOKEN, TOKEN+b' ', b'\t'+TOKEN,
                      TOKEN+b'\r\n', TOKEN+b'\n\n', b'\n'+TOKEN,
                      TOKEN+b'\v', TOKEN+b'\f')


class CredentialContractTests(unittest.TestCase):
    def setUp(self):
        self.case = init_fixture.InitializationTests()
        self.addCleanup(self.case.doCleanups)
        self.case.setUp()

    def activation(self):
        case = activation_fixture.ActivationTests()
        self.addCleanup(case.doCleanups)
        case.setUp()
        return case

    def snapshot(self):
        # Reading may update atime; all persistent credential identity/bytes and
        # installation content must otherwise be preserved on rejection/reuse.
        st = self.case.token.stat()
        return self.case.snapshot(), (st.st_dev, st.st_ino, st.st_ctime_ns, st.st_nlink)

    def check_valid(self, raw):
        self.case.put(m.TOKEN, raw)
        before = self.snapshot()
        for action in ('status', 'create-token'):
            code, value = self.case.cli(action)
            self.assertEqual(code, 0)
            self.assertTrue(value['credential_ready'])
            self.assertEqual(value['token_creation'], 'existing')
            self.assertNotIn(TOKEN.decode(), json.dumps(value))
            self.assertEqual(self.snapshot(), before)
        target = self.activation()
        target.token.write_bytes(raw)
        self.assertIn('activation_plan_sha256', target.plan())
        self.assertEqual(target.bus.starts, [])

    def test_plain_token_reuse_and_actual_activation_plan_agree(self):
        self.check_valid(TOKEN)

    def test_single_lf_token_reuse_and_actual_activation_plan_agree(self):
        self.check_valid(TOKEN+b'\n')

    def test_newly_created_token_passes_actual_activation_plan_without_reencoding(self):
        code, value = self.case.cli('create-token')
        self.assertEqual(code, 0)
        self.assertEqual(value['token_creation'], 'created')
        raw = self.case.token.read_bytes()
        target = self.activation()
        target.token.write_bytes(raw)
        before = target.token.read_bytes()
        self.assertIn('activation_plan_sha256', target.plan())
        self.assertEqual(target.token.read_bytes(), before)
        self.assertEqual(target.bus.starts, [])

    def test_direct_initializer_and_activation_both_reject_extra_whitespace(self):
        target = self.activation()
        for index, raw in enumerate(INVALID_WHITESPACE):
            with self.subTest(case=index):
                self.case.put(m.TOKEN, raw)
                target.token.write_bytes(raw)
                before = self.snapshot()
                with self.assertRaisesRegex(Exception, 'invalid_console_token'):
                    target.plan()
                for action in ('status', 'create-token'):
                    with self.assertRaisesRegex(m.PREFLIGHT.PreflightError, 'invalid_console_token'):
                        self.case.run_init(action)
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(target.bus.starts, [])

    def check_cli_rejection(self, action):
        for index, raw in enumerate(INVALID_WHITESPACE):
            with self.subTest(case=index):
                self.case.put(m.TOKEN, raw)
                before = self.snapshot()
                code, value = self.case.cli(action)
                self.assertEqual(code, 1)
                self.assertEqual(value['error'], 'invalid_console_token')
                self.assertFalse(value['ok'])
                self.assertEqual(value['token_creation'], 'not_proven')
                self.assertNotIn('credential_ready', value)
                self.assertFalse(value['token_value_returned'])
                self.assertNotIn(TOKEN.decode(), json.dumps(value))
                self.assertEqual(self.snapshot(), before)

    def test_public_status_never_certifies_noncanonical_existing_token(self):
        self.check_cli_rejection('status')

    def test_public_create_never_normalizes_or_rotates_noncanonical_existing_token(self):
        self.check_cli_rejection('create-token')

    def test_concurrent_external_creator_cannot_supply_noncanonical_token(self):
        original_open = m.os.open
        raw = TOKEN+b'\r\n'
        def race(path, flags, *args, **kwargs):
            if path == m.TOKEN and flags & os.O_CREAT:
                self.case.put(m.TOKEN, raw)
            return original_open(path, flags, *args, **kwargs)
        with patch.object(m.os, 'open', side_effect=race):
            with self.assertRaisesRegex(m.PREFLIGHT.PreflightError, 'invalid_console_token'):
                self.case.run_init()
        self.assertEqual(self.case.token.read_bytes(), raw)

    def test_optimized_interpreter_preserves_rejection_and_original_bytes(self):
        raw = TOKEN+b'\r\n'
        self.case.put(m.TOKEN, raw)
        before = self.snapshot()
        child = subprocess.run(['/usr/bin/python3', '-I', '-B', '-OO',
            str(ROOT/'scripts/personal-init.py'), 'status', '--home', str(self.case.home)],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(child.returncode, 1)
        self.assertEqual(child.stderr, '')
        self.assertEqual(json.loads(child.stdout)['error'], 'invalid_console_token')
        self.assertNotIn(TOKEN.decode(), child.stdout)
        self.assertEqual(self.snapshot(), before)

    def main(self, args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = m.main(args)
        return code, json.loads(output.getvalue())

    def test_explicit_environment_home_does_not_evaluate_account_default(self):
        self.case.put(m.TOKEN, TOKEN)
        with patch.dict(m.os.environ, {'ULTRABRAIN_HOME': str(self.case.home)}), \
             patch.object(m.Path, 'home', side_effect=RuntimeError('SYNTHETIC_ACCOUNT_PRIVATE')):
            code, value = self.main(['status'])
        self.assertEqual(code, 0)
        self.assertTrue(value['credential_ready'])

    def test_explicit_cli_home_does_not_evaluate_account_default(self):
        self.case.put(m.TOKEN, TOKEN)
        with patch.object(m.Path, 'home', side_effect=AssertionError('must not resolve')):
            code, value = self.main(['status', '--home', str(self.case.home)])
        self.assertEqual(code, 0)
        self.assertTrue(value['credential_ready'])

    def test_platform_and_uid_gate_precedes_any_implicit_home_lookup(self):
        for platform, uid, euid, expected in (
            ('win32', 1000, 1000, 'server_requires_linux'),
            ('linux', 0, 0, 'use_ordinary_service_account'),
            ('linux', 1000, 0, 'use_ordinary_service_account')):
            with self.subTest(platform=platform, uid=uid, euid=euid), \
                 patch.dict(m.os.environ, {}, clear=True), \
                 patch.object(m.sys, 'platform', platform), \
                 patch.object(m.os, 'getuid', return_value=uid), \
                 patch.object(m.os, 'geteuid', return_value=euid), \
                 patch.object(m.Path, 'home', side_effect=AssertionError('must not resolve')):
                code, value = self.main(['status'])
                self.assertEqual(code, 1)
                self.assertEqual(value['error'], expected)

    def test_needed_account_default_resolves_once_inside_safe_error_boundary(self):
        with patch.dict(m.os.environ, {}, clear=True), \
             patch.object(m.Path, 'home', return_value=Path('/synthetic/account')) as home, \
             patch.object(m, 'initialize', return_value={'ok': True}) as initialize:
            code, _ = self.main(['status'])
        self.assertEqual(code, 0)
        home.assert_called_once_with()
        initialize.assert_called_once_with('status', '/synthetic/account/.local/share/ultrabrain')
        with patch.dict(m.os.environ, {}, clear=True), \
             patch.object(m.Path, 'home', side_effect=RuntimeError('SYNTHETIC_ACCOUNT_PRIVATE')):
            code, value = self.main(['status'])
        self.assertEqual(code, 1)
        self.assertNotIn('SYNTHETIC', json.dumps(value))


if __name__ == '__main__':
    unittest.main()
