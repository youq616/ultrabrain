"""Separate implementation self-review regressions, not an independent-agent approval."""
import json
from pathlib import Path
import importlib.util
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('status_test_helpers',Path(__file__).with_name('test_personal_status.py'))
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
s=h.s

class ReviewTests(unittest.TestCase):
    def report(self,rows=None):
        with patch.object(s.os,'geteuid',return_value=1001):
            return s.collect(runner=lambda:(0,h.wire(rows or h.records())))

    def test_unit_names_do_not_prove_current_installation_binding(self):
        out=self.report()
        self.assertTrue(out['ok'])
        self.assertIs(out.get('installation_binding_verified'),False)

    def test_unknown_optional_worker_is_visible_without_echoing_value(self):
        rows=h.records(True);rows[s.UNITS[3]]['SubState']='PRIVATE_UNKNOWN_STATE'
        out=self.report(rows)
        self.assertTrue(out['ok'])  # Worker is not required by this explicit check.
        self.assertIn('optional_worker_state_unrecognized',out['warnings'])
        self.assertNotIn('PRIVATE_UNKNOWN_STATE',json.dumps(out))

    def test_absent_optional_worker_does_not_get_unknown_warning(self):
        rows=h.records();rows[s.UNITS[3]].update(Type='',Result='')
        out=self.report(rows)
        self.assertEqual(out['warnings'],[])
        self.assertEqual(out['units'][3]['reason'],'unit_not_found')

    def test_truncated_inventory_does_not_report_stopped_services(self):
        raw=h.wire(h.records()).rsplit(b'\n\n',1)[0]
        with patch.object(s.os,'geteuid',return_value=1001):
            out=s.collect(runner=lambda:(0,raw))
        self.assertEqual(out['status'],'unavailable')
        self.assertEqual(out['units'],[])

    def test_selected_properties_exclude_config_paths_arguments_and_raw_logs(self):
        self.assertEqual(set(s.PROPERTIES),{'Id','LoadState','ActiveState','SubState','Type',
                                          'Result','ExecMainCode','ExecMainStatus','NRestarts'})
        self.assertEqual(s.command()[-4:],list(s.UNITS))
        self.assertNotIn('status',s.command())

if __name__=='__main__':unittest.main()
