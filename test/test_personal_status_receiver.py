"""Receiver adversarial review; synthetic manager data is not a live-systemd pass."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('status_receiver_helpers',
    Path(__file__).with_name('test_personal_status.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
s = h.s

class ReceiverTests(unittest.TestCase):
    def report(self, code, rows=None, raw=None):
        data = h.wire(h.records() if rows is None else rows) if raw is None else raw
        with patch.object(s.os, 'geteuid', return_value=1001):
            return s.collect(runner=lambda: (code, data))

    def test_complete_not_found_exit_five_is_not_manager_unavailable(self):
        rows = h.records()
        for row in rows.values():
            row.update(LoadState='not-found', ActiveState='inactive', SubState='dead')
        out = self.report(5, rows)
        self.assertFalse(out['ok'])
        self.assertEqual(out['status'], 'required_units_not_active')
        self.assertEqual(len(out['units']), 4)
        self.assertTrue(all(u['reason'] == 'unit_not_found' for u in out['units']))

    def test_missing_optional_worker_exit_five_preserves_required_units(self):
        out = self.report(5)
        self.assertTrue(out['ok'])
        self.assertEqual(out['status'], 'required_units_active')
        self.assertFalse(out['installation_binding_verified'])
        self.assertEqual(out['application_ready'], 'not_checked')

    def test_other_failure_codes_never_succeed_because_optional_unit_is_absent(self):
        for code in (1, 2, 3, 4, 6, 124, -9):
            with self.subTest(code=code):
                out = self.report(code)
                self.assertFalse(out['ok'])
                self.assertEqual(out['status'], 'unavailable')
                self.assertEqual(out['units'], [])

    def test_exit_five_requires_explicit_inactive_not_found_evidence(self):
        for rows in (h.records(True), h.records()):
            if rows[s.UNITS[3]]['LoadState'] == 'not-found':
                rows[s.UNITS[3]]['ActiveState'] = 'active'
            out = self.report(5, rows)
            self.assertFalse(out['ok'])
            self.assertEqual(out['status'], 'unavailable')

    def test_missing_or_truncated_properties_still_refuse_exit_five(self):
        for raw in (b'', h.wire(h.records()).rsplit(b'\n\n', 1)[0]):
            self.assertEqual(self.report(5, raw=raw)['status'], 'unavailable')

    def test_exit_code_contract_requires_actual_integer(self):
        for code in (False, 0.0, '0', None):
            with self.subTest(code=code):
                self.assertEqual(self.report(code)['status'], 'unavailable')

    def test_property_and_record_order_are_not_significant(self):
        rows = {name: dict(reversed(list(row.items())))
                for name, row in reversed(list(h.records(True).items()))}
        self.assertEqual(self.report(0, rows), self.report(0, h.records(True)))

    def test_absent_worker_empty_service_enums_do_not_create_false_warning(self):
        rows = h.records()
        rows[s.UNITS[3]].update(Type='', Result='')
        out = self.report(5, rows)
        self.assertTrue(out['ok'])
        self.assertEqual(out['warnings'], [])

    def test_actual_subprocess_exit_five_reaches_parser_without_raw_stderr(self):
        program = 'import sys;sys.stdout.buffer.write(' + repr(h.wire(h.records())) + \
            ');sys.stderr.write("SYNTHETIC_PRIVATE_DIAGNOSTIC");sys.exit(5)'
        with patch.object(s, 'command', return_value=[sys.executable, '-I', '-c', program]):
            code, raw = s.run_show()
        out = self.report(code, raw=raw)
        self.assertTrue(out['ok'])
        self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(out))

if __name__ == '__main__':
    unittest.main()
