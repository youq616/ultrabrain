"""The composition cannot reset its budget at each async component boundary."""
import time
import unittest
from unittest.mock import patch
import test_personal_setup as fixture

m = fixture.m


class SetupDeadlineTests(unittest.TestCase):
    put = fixture.SetupTests.put
    snapshot = fixture.SetupTests.snapshot
    run_setup = fixture.SetupTests.run_setup

    def setUp(self):
        fixture.SetupTests.setUp(self)
        self.now = 100.0
        clock = patch.object(time, 'monotonic', side_effect=lambda: self.now)
        clock.start(); self.addCleanup(clock.stop)

    def test_both_probes_inherit_the_same_total_deadline(self):
        def advance(_): self.now += 4
        self.on_observe = advance
        self.run_setup()
        self.assertEqual(self.deadlines, [120.0, 120.0])

    def test_expiry_during_first_probe_prevents_credential_creation(self):
        self.on_observe = lambda _: setattr(self, 'now', 120.0)
        with self.assertRaisesRegex(Exception, 'setup_timeout'): self.run_setup()
        self.assertFalse(self.token.exists()); self.assertEqual(len(self.calls), 1)

    def test_expiry_during_prewrite_binding_check_prevents_creation(self):
        def database(*_):
            if self.calls: self.now = 120.0
            return dict(self.db)
        with patch.object(m.PROCESS, 'database_snapshot', side_effect=database):
            with self.assertRaisesRegex(Exception, 'setup_timeout'): self.run_setup()
        self.assertFalse(self.token.exists()); self.assertEqual(len(self.calls), 1)

    def test_expiry_after_creation_keeps_token_without_another_probe(self):
        original = m.INIT.initialize
        def slow(*args, **kwargs):
            result = original(*args, **kwargs); self.now = 120.0; return result
        with patch.object(m.INIT, 'initialize', side_effect=slow) as call:
            with self.assertRaisesRegex(Exception, 'setup_timeout'): self.run_setup()
        self.assertTrue(self.token.exists()); self.assertEqual(call.call_count, 1)
        self.assertEqual(len(self.calls), 1)

    def test_expiry_during_final_probe_cannot_certify_preparation(self):
        def advance(n):
            if n == 2: self.now = 120.0
        self.on_observe = advance
        with self.assertRaisesRegex(Exception, 'setup_timeout'): self.run_setup()
        self.assertTrue(self.token.exists()); self.assertEqual(len(self.calls), 2)

    def test_expired_check_preserves_existing_bytes_and_never_creates(self):
        self.put(m.INIT.TOKEN, b'a'*64); before = self.snapshot()
        self.on_observe = lambda _: setattr(self, 'now', 120.0)
        with self.assertRaisesRegex(Exception, 'setup_timeout'): self.run_setup('check')
        self.assertEqual(self.snapshot(), before); self.assertEqual(len(self.calls), 1)
