"""Real private-file initialization composed with synthetic identity/process probes.

Actual Unix/SCRAM/PostgreSQL composition is covered by the dedicated CI fixture.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import test_personal_init as init_fixture

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('setup_test', ROOT/'scripts/personal-setup.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
INSTANCE = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'


def identity(**changes):
    return {'format': 1, 'ok': True, 'source_id': 'default', 'instance_id': INSTANCE,
            'identity_verified': True, 'database_process_binding_verified': True,
            'transport': 'private-unix-socket', 'authentication': 'os-peer-and-scram-sha-256', **changes}


class SetupTests(unittest.TestCase):
    put = init_fixture.InitializationTests.put
    snapshot = init_fixture.InitializationTests.snapshot

    def setUp(self):
        init_fixture.InitializationTests.setUp(self)
        self.calls = []
        self.deadlines = []
        self.on_observe = lambda n: None
        self.responses = [identity(), identity()]
        self.db = {'postmaster_pid': 31415, 'generation': 'synthetic-process-binding'}
        def observe(home, source, *, root, deadline=None):
            self.assertEqual(home, self.home); self.assertEqual(root, self.repo)
            self.calls.append(source)
            self.deadlines.append(deadline)
            self.on_observe(len(self.calls))
            return self.responses[len(self.calls)-1]
        for target, name, fn in [(m.IDENTITY, 'observe', observe),
                                 (m.PROCESS, 'database_snapshot', lambda *_: dict(self.db))]:
            p = patch.object(target, name, side_effect=fn); p.start(); self.addCleanup(p.stop)

    def run_setup(self, action='prepare', **options):
        return m.setup(action, self.home, root=self.repo, **options)

    def test_check_reports_missing_credential_and_verified_identity_without_writing(self):
        before = self.snapshot(); result = self.run_setup('check')
        self.assertFalse(result['ok']); self.assertEqual(result['state'], 'credentials_required')
        self.assertTrue(result['identity_verified']); self.assertEqual(result['instance_id'], INSTANCE)
        self.assertEqual(result['token_creation'], 'absent'); self.assertFalse(result['credential_ready'])
        self.assertEqual(self.snapshot(), before); self.assertEqual(self.calls, ['default', 'default'])

    def test_prepare_creates_token_only_after_first_identity_and_reverifies(self):
        before = self.snapshot(); observed = []
        self.on_observe = lambda n: observed.append((n, self.token.exists()))
        result = self.run_setup(); self.assertEqual(observed, [(1, False), (2, True)])
        self.assertTrue(result['prepared']); self.assertEqual(result['token_creation'], 'created')
        self.assertEqual(result['application_readiness'], 'not_checked')
        self.assertEqual(result['deployment_readiness'], 'not_checked')
        self.assertNotIn('application_ready', result)
        self.assertEqual(self.token.stat().st_mode & 0o777, 0o600)
        after = self.snapshot(); after.pop(m.INIT.TOKEN); self.assertEqual(after, before)
        for key, value in m.NO_ACTIONS.items(): self.assertEqual(result[key], value)
        for secret in [self.token.read_text().strip(), self.state['app_password'], self.state['admin_password'],
                       self.config['provider_key'], str(self.home)]: self.assertNotIn(secret, json.dumps(result))

    def test_existing_credentials_are_reused_without_randomness_or_metadata_changes(self):
        self.put(m.INIT.TOKEN, b'a'*64+b'\n'); before = self.snapshot()
        with patch.object(m.INIT.secrets, 'token_hex', side_effect=AssertionError('No creation')):
            for action in ('check', 'prepare'):
                self.calls.clear()
                self.assertEqual(self.run_setup(action)['token_creation'], 'existing')
        self.assertEqual(before, self.snapshot())

    def test_expected_instance_mismatch_precedes_any_credential_write(self):
        with self.assertRaisesRegex(Exception, 'setup_instance_mismatch'):
            self.run_setup(expected_instance=OTHER)
        self.assertFalse(self.token.exists()); self.assertEqual(len(self.calls), 1)

    def test_matching_explicit_instance_keeps_same_identity(self):
        self.assertEqual(self.run_setup(expected_instance=INSTANCE)['instance_id'], INSTANCE)

    def test_selected_source_is_forwarded_to_both_probes_without_override(self):
        self.responses = [identity(source_id='chosen'), identity(source_id='chosen')]
        self.assertEqual(self.run_setup(source='chosen')['source_id'], 'chosen')
        self.assertEqual(self.calls, ['chosen', 'chosen'])

    def test_initial_identity_failure_creates_nothing_and_is_not_retried(self):
        def failed(_): raise m.IDENTITY.IdentityError('identity_timeout')
        self.on_observe = failed
        with self.assertRaisesRegex(Exception, 'identity_timeout'): self.run_setup()
        self.assertFalse(self.token.exists()); self.assertEqual(len(self.calls), 1)

    def test_final_identity_failure_preserves_created_token_without_claiming_success(self):
        def failed(n):
            if n == 2: raise m.IDENTITY.IdentityError('identity_source_unavailable')
        self.on_observe = failed
        with self.assertRaisesRegex(Exception, 'identity_source_unavailable'): self.run_setup()
        self.assertTrue(self.token.exists()); before = self.token.read_bytes()
        self.on_observe = lambda _: None; self.calls.clear()
        self.assertEqual(self.run_setup()['token_creation'], 'existing')
        self.assertEqual(self.token.read_bytes(), before)

    def test_changed_logical_identity_after_creation_is_not_accepted(self):
        self.responses[1] = identity(instance_id=OTHER)
        with self.assertRaisesRegex(Exception, 'setup_instance_mismatch'): self.run_setup()
        self.assertTrue(self.token.exists())

    def test_malformed_component_identity_is_not_a_success_or_write_authority(self):
        for changed in [{'ok':False}, {'format':True}, {'identity_verified':1}, {'database_process_binding_verified':False},
                        {'source_id':'foreign'}, {'instance_id':'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}, {'instance_id':None},
                        {'instance_id':'00000000-0000-0000-0000-000000000000'}, {'transport':'tcp'}, {'authentication':'none'}]:
            self.calls.clear(); self.responses[0] = identity(**changed)
            with self.subTest(changed=changed), self.assertRaises(Exception): self.run_setup()
            self.assertFalse(self.token.exists())

    def test_untrusted_component_extras_are_not_in_the_public_report(self):
        self.responses = [identity(password='SYNTHETIC_FORGED_SECRET')]*2
        self.assertNotIn('SYNTHETIC_FORGED_SECRET', json.dumps(self.run_setup()))

    def test_config_change_during_identity_is_detected_before_creation(self):
        target = self.home/'gbrain/.gbrain/config.json'
        self.on_observe = lambda _: target.write_bytes(target.read_bytes()+b' ')
        with self.assertRaisesRegex(Exception, 'managed_path_changed_during_check'): self.run_setup()
        self.assertFalse(self.token.exists())

    def test_initial_token_replacement_during_query_is_detected_without_overwrite(self):
        self.put(m.INIT.TOKEN, b'a'*64)
        self.on_observe = lambda _: self.token.write_bytes(b'b'*64)
        with self.assertRaisesRegex(Exception, 'managed_path_changed_during_check'): self.run_setup()
        self.assertEqual(self.token.read_bytes(), b'b'*64)

    def test_token_replacement_during_final_probe_is_detected(self):
        def change(n):
            if n == 2: self.token.write_bytes(b'c'*64)
        self.on_observe = change
        with self.assertRaisesRegex(Exception, 'managed_path_changed_during_check'): self.run_setup()
        self.assertEqual(self.token.read_bytes(), b'c'*64)

    def test_physical_database_change_between_components_fails_even_with_same_uuid(self):
        self.on_observe = lambda _: self.db.update(generation='changed')
        with self.assertRaisesRegex(Exception, 'database_changed_during_check'): self.run_setup()
        self.assertFalse(self.token.exists())

    def test_source_lock_change_prevents_creation(self):
        self.on_observe = lambda _: (self.repo/'upstreams.lock.json').write_bytes(b'{}')
        with self.assertRaises(Exception): self.run_setup()
        self.assertFalse(self.token.exists())

    def test_lost_deployed_token_refuses_before_query_and_is_not_recreated(self):
        (self.home/'personal-deployment').mkdir(mode=0o700)
        for action in ('check', 'prepare'):
            with self.subTest(action=action), self.assertRaisesRegex(Exception, 'token_recovery_required'): self.run_setup(action)
        self.assertEqual(self.calls, []); self.assertFalse(self.token.exists())

    def test_deployment_history_appearing_after_identity_still_prevents_creation(self):
        self.on_observe = lambda _: (self.home/'personal-activation').mkdir(mode=0o700)
        with self.assertRaisesRegex(Exception, 'token_recovery_required'): self.run_setup()
        self.assertFalse(self.token.exists())

    def test_missing_home_is_not_initialized(self):
        absent = self.base/'absent'
        with self.assertRaises(Exception): m.setup('prepare', absent, root=self.repo)
        self.assertFalse(absent.exists()); self.assertEqual(self.calls, [])

    def test_unsafe_credentials_fail_before_query_and_are_preserved(self):
        self.put(m.INIT.TOKEN, b'partial'); before = self.token.read_bytes()
        with self.assertRaisesRegex(Exception, 'invalid_console_token'): self.run_setup()
        self.assertEqual(self.calls, []); self.assertEqual(self.token.read_bytes(), before)

    def test_bad_selection_and_expected_instance_refuse_before_inspection(self):
        for kwargs in [{'expected_instance':'bad'}, {'expected_instance':True}, {'expected_instance':''},
                       {'source':'../other'}, {'source':'UPPER'}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(Exception): self.run_setup(**kwargs)
        self.assertEqual(self.calls, []); self.assertFalse(self.token.exists())

    def test_non_linux_root_and_uid_mismatch_refuse_before_query_or_write(self):
        with patch.object(m.IDENTITY.sys, 'platform', 'win32'), self.assertRaises(Exception): self.run_setup()
        for name, value in [('getuid',0), ('geteuid',0), ('geteuid',os.getuid()+1)]:
            with patch.object(m.IDENTITY.os, name, return_value=value), self.assertRaises(Exception): self.run_setup()
        self.assertEqual(self.calls, []); self.assertFalse(self.token.exists())

    def test_bad_credential_component_report_does_not_certify_preparation(self):
        original = m.INIT.initialize
        for changed in [{'format':True}, {'ok':False}, {'credential_ready':1}, {'managed_configuration_verified':False},
                        {'token_creation':'created-by-magic'}, {'token_file':'other'}, {'token_value_returned':True}]:
            self.calls.clear()
            def result(*args, **kwargs): return {**original(*args, **kwargs), **changed}
            with self.subTest(changed=changed), patch.object(m.INIT, 'initialize', side_effect=result), self.assertRaises(Exception):
                self.run_setup()
            self.assertEqual(len(self.calls), 1)

    def test_home_replacement_during_identity_is_not_adopted(self):
        moved = self.base/'moved'
        def move(_):
            self.home.rename(moved); self.home.mkdir(mode=0o700)
        self.on_observe = move
        with self.assertRaisesRegex(Exception, 'home_changed_during_check'): self.run_setup()
        self.assertFalse(self.token.exists()); self.assertFalse((moved/m.INIT.TOKEN).exists())

    def test_existing_initializer_lock_is_respected_without_a_second_write(self):
        import fcntl
        with m.PREFLIGHT.PrivateHome(self.home) as view:
            fcntl.flock(view.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(Exception, 'initialization_busy'): self.run_setup()
        self.assertFalse(self.token.exists()); self.assertEqual(len(self.calls), 1)

    def test_initializer_failure_is_not_retried_and_no_final_query_is_made(self):
        with patch.object(m.INIT, 'initialize', side_effect=OSError('SYNTHETIC_PRIVATE')) as call:
            with self.assertRaises(OSError): self.run_setup()
            self.assertEqual(call.call_count, 1)
        self.assertEqual(len(self.calls), 1); self.assertFalse(self.token.exists())


class SetupCliTests(unittest.TestCase):
    def call(self, args, **patches):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.ExitStack() as stack:
            for name, value in patches.items(): stack.enter_context(patch.object(m, name, **value))
            code = m.main(args)
        return code, json.loads(out.getvalue())

    def test_errors_have_no_partial_identity_or_raw_exception_content(self):
        code, result = self.call(['prepare','--home','/tmp/not-used'], setup={'side_effect':RuntimeError('SYNTHETIC_SECRET')})
        self.assertEqual(code, 1); self.assertEqual(result['error'], 'setup_unverified')
        self.assertEqual(result['token_creation'], 'not_proven'); self.assertNotIn('instance_id', result)
        self.assertNotIn('SYNTHETIC_SECRET', json.dumps(result))

    def test_explicit_home_does_not_evaluate_account_default(self):
        with patch.object(m.Path, 'home', side_effect=RuntimeError('No passwd lookup')):
            code, _ = self.call(['check','--home','/tmp/not-used'], setup={'return_value':{'ok':True}})
        self.assertEqual(code, 0)

    def test_environment_home_does_not_evaluate_account_default(self):
        with patch.dict(os.environ, {'ULTRABRAIN_HOME':'/tmp/not-used'}), patch.object(m.Path, 'home', side_effect=RuntimeError):
            code, _ = self.call(['check'], setup={'return_value':{'ok':True}})
        self.assertEqual(code, 0)

    def test_missing_credential_report_keeps_nonzero_status_without_losing_verified_identity(self):
        code, result = self.call(['check','--home','/tmp/not-used'], setup={'return_value':{'ok':False,'identity_verified':True,'instance_id':INSTANCE}})
        self.assertEqual(code, 1); self.assertEqual(result['instance_id'], INSTANCE)
