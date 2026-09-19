"""Composition tests on private fixture files; manager/database identity are simulated."""
import contextlib
import copy
import fcntl
import importlib.util
import io
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_fixture', ROOT/'test/test_personal_activate.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
m = fixture.m

class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.ActivationTests()
        self.addCleanup(self.case.doCleanups)
        self.case.setUp()
        self.observation = {'format': 1, 'ok': True, 'source_id': 'personal', 'instance_id': fixture.INSTANCE,
            'identity_verified': True, 'database_process_binding_verified': True,
            'transport': 'private-unix-socket', 'authentication': 'os-peer-and-scram-sha-256'}
        self.calls = []
        self.after_identity = lambda: None
        self.options = {k:v for k,v in self.case.options.items() if k != 'expected_instance'}

    def observe(self, home, source, *, root, deadline):
        self.assertGreater(deadline, time.monotonic())
        self.assertLessEqual(deadline, time.monotonic()+30)
        self.assertEqual(Path(home), self.case.home)
        self.assertEqual(source, 'personal')
        self.assertEqual(Path(root), ROOT)
        # Observation cannot run outside the activation/deployment reader lock.
        with self.assertRaisesRegex(Exception, 'deployment_busy'):
            with self.case.deployer._lock(write=True):
                self.fail('competing writer acquired preparation lock')
        self.calls.append('observe')
        self.after_identity()
        return copy.deepcopy(self.observation)

    def prepare(self, **changes):
        with patch.object(m, 'IDENTITY', SimpleNamespace(observe=self.observe), create=True):
            return self.case.context().prepare(**{**self.options, **changes})

    def test_preparation_is_read_only_and_returns_the_existing_canonical_plan(self):
        before = fixture.d.tree_snapshot(self.case.base)
        plan = self.prepare()
        self.assertEqual(self.calls, ['observe'])
        self.assertEqual(plan, self.case.plan())
        self.assertEqual(fixture.d.tree_snapshot(self.case.base), before)
        self.assertFalse(self.case.activation.exists())
        self.assertEqual(self.case.bus.starts, [])
        self.assertEqual(self.case.probes, 0)
        self.assertNotIn(fixture.TOKEN, json.dumps(plan))

    def test_prepared_plan_requires_explicit_apply_and_retains_original_guards(self):
        plan = self.prepare()
        self.assertEqual(self.case.bus.starts, [])
        result = self.case.context().apply(expected_plan=plan['activation_plan_sha256'], **self.case.options)
        self.assertTrue(result['application_ready'])
        self.assertEqual(len(self.case.bus.starts), 1)

    def test_wrong_generation_source_port_and_binary_refuse_before_identity(self):
        for change in ({'expected_current':'f'*64}, {'source':'foreign'}, {'port':3133}, {'bun':'/bin/foreign'}):
            with self.subTest(change=change), self.assertRaises(Exception):
                self.prepare(**change)
        self.assertEqual(self.calls, [])

    def test_unverified_or_wrong_source_identity_never_produces_a_plan(self):
        original = copy.deepcopy(self.observation)
        for change in ({'ok':False}, {'format':True}, {'source_id':'foreign'}, {'identity_verified':False},
                       {'database_process_binding_verified':False}, {'instance_id':'bad'},
                       {'instance_id':'00000000-0000-0000-0000-000000000000'},
                       {'transport':'http'}, {'authentication':'none'}):
            self.observation = {**original, **change}
            with self.subTest(change=change), self.assertRaises(Exception):
                self.prepare()
        self.assertEqual(self.case.bus.starts, [])

    def test_database_replacement_between_identity_and_plan_is_refused(self):
        self.after_identity = lambda: self.case.database['postmaster'].update(start_ticks=999)
        with self.assertRaisesRegex(Exception, 'database_changed_during_check'):
            self.prepare()
        self.assertEqual(self.case.bus.starts, [])

    def test_token_replacement_during_identity_is_refused(self):
        self.after_identity = lambda: self.case.token.write_text('b'*64+'\n')
        with self.assertRaises(Exception):
            self.prepare()
        self.assertEqual(self.case.bus.starts, [])

    def test_missing_token_never_initializes_or_queries_identity(self):
        self.case.token.unlink()
        with self.assertRaises(Exception):
            self.prepare()
        self.assertEqual(self.calls, [])
        self.assertFalse(self.case.token.exists())

    def test_pending_activation_refuses_before_identity(self):
        self.case.interrupt('after_journal')
        before = fixture.d.tree_snapshot(self.case.base)
        with self.assertRaises(Exception):
            self.prepare()
        self.assertEqual(self.calls, [])
        self.assertEqual(fixture.d.tree_snapshot(self.case.base), before)

    def test_exclusive_lock_refuses_before_identity(self):
        with open(self.case.shared/'lock', 'rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(Exception, 'deployment_busy'):
                self.prepare()
        self.assertEqual(self.calls, [])

    def test_identity_failure_closes_manager_without_writes(self):
        before = fixture.d.tree_snapshot(self.case.base)
        def fail():
            raise OSError('SYNTHETIC_IDENTITY_PRIVATE')
        self.after_identity = fail
        with self.assertRaises(OSError):
            self.prepare()
        self.assertEqual(fixture.d.tree_snapshot(self.case.base), before)
        self.assertTrue(all(manager.closed for manager in self.case.managers))

    def test_manager_identity_or_cached_graph_change_cannot_yield_a_plan(self):
        for target, change in [(self.case.bus.identity, {'manager_start_ticks': 999}),
                               (self.case.bus.contract, {'cached_command': 'changed'})]:
            original = copy.deepcopy(target)
            self.after_identity = lambda: target.update(change)
            with self.subTest(change=change), self.assertRaisesRegex(Exception, 'preparation_binding_changed'):
                self.prepare()
            target.clear(); target.update(original)
        self.assertEqual(self.case.bus.starts, [])

class HomeSelectionTests(unittest.TestCase):
    def invoke(self, argv, env, *, uid=1234, factory=None, account_error=True):
        lookup = RuntimeError('SYNTHETIC_ACCOUNT_PRIVATE') if account_error else SimpleNamespace(pw_dir='/synthetic-account')
        with patch.dict(os.environ, env, clear=True), patch.object(m.sys, 'platform', 'linux'), \
             patch.object(m.os, 'getuid', return_value=uid), patch.object(m.os, 'geteuid', return_value=uid), \
             patch.object(m.pwd, 'getpwuid', side_effect=lookup if account_error else None,
                          return_value=lookup) as getpw, contextlib.redirect_stdout(io.StringIO()) as out:
            rc = m.main(argv, context_factory=factory or (lambda _: self.fail('unexpected context')))
        self.assertNotIn('SYNTHETIC_ACCOUNT_PRIVATE', out.getvalue())
        return rc, json.loads(out.getvalue()), getpw.call_count

    def test_explicit_home_avoids_unused_account_lookup(self):
        seen=[]
        context=SimpleNamespace(status=lambda:{'state':'fixture'}, manager=SimpleNamespace(close=lambda:None))
        rc, _, calls=self.invoke(['status','--home','/chosen'], {}, factory=lambda home:seen.append(home) or context)
        self.assertEqual((rc,calls,seen),(0,0,['/chosen']))

    def test_environment_home_avoids_unused_account_lookup(self):
        seen=[]
        context=SimpleNamespace(status=lambda:{'state':'fixture'}, manager=SimpleNamespace(close=lambda:None))
        rc, _, calls=self.invoke(['status'], {'ULTRABRAIN_HOME':'/environment'}, factory=lambda home:seen.append(home) or context)
        self.assertEqual((rc,calls,seen),(0,0,['/environment']))

    def test_root_and_invalid_arguments_refuse_before_account_lookup(self):
        for argv,uid,error in [(['status'],0,'ordinary_linux_account_required'),
                               (['stop'],1234,'invalid_arguments')]:
            with self.subTest(argv=argv,uid=uid):
                rc, value, calls=self.invoke(argv, {}, uid=uid)
                self.assertEqual((rc,value['error'],calls),(1,error,0))

    def test_default_account_lookup_failure_remains_redacted(self):
        rc,value,calls=self.invoke(['status'], {})
        self.assertEqual((rc,value['error'],calls),(1,'personal_activation_failed',1))

    def test_cli_preparation_dispatches_only_read_only_prepare_and_closes_context(self):
        seen, closed = [], []
        context = SimpleNamespace(prepare=lambda **kwargs: seen.append(kwargs) or {'plan': 'fixture'},
                                  manager=SimpleNamespace(close=lambda: closed.append(True)))
        rc, value, calls = self.invoke(['prepare', '--home', '/chosen', '--bun', '/bin/bun',
            '--source', 'personal', '--port', '3133', '--expected-current', 'a'*64], {}, factory=lambda _: context)
        self.assertEqual((rc, calls, closed), (0, 0, [True]))
        self.assertEqual(value['result'], {'plan': 'fixture'})
        self.assertEqual(seen, [{'bun': '/bin/bun', 'source': 'personal', 'port': 3133, 'expected_current': 'a'*64}])

class DeadlineTests(unittest.TestCase):
    def test_nested_identity_uses_the_callers_shorter_remaining_budget(self):
        with patch.object(m.IDENTITY.time, 'monotonic', return_value=100):
            self.assertEqual(m.IDENTITY.observation_deadline(101), 101)

    def test_caller_cannot_extend_the_standalone_ten_second_limit(self):
        with patch.object(m.IDENTITY.time, 'monotonic', return_value=100):
            self.assertEqual(m.IDENTITY.observation_deadline(140), 110)
            self.assertEqual(m.IDENTITY.observation_deadline(), 110)

    def test_invalid_deadlines_fail_instead_of_disabling_timeouts(self):
        for value in [True, False, '120', float('inf'), float('-inf'), float('nan')]:
            with self.subTest(value=repr(value)), self.assertRaisesRegex(Exception, 'invalid_identity_deadline'):
                m.IDENTITY.observation_deadline(value)

    def test_expired_budget_refuses_before_installation_inspection(self):
        with patch.object(m.IDENTITY, 'platform_check'), patch.object(m.IDENTITY.time, 'monotonic', return_value=100), \
             patch.object(m.IDENTITY.PREFLIGHT, 'check_pins', side_effect=AssertionError('No inspection')) as check:
            with self.assertRaisesRegex(Exception, 'identity_timeout'):
                m.IDENTITY.observe('/synthetic-install', root='/synthetic-source', deadline=99)
        check.assert_not_called()
