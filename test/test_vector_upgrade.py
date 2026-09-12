"""Operational safety checks use no live database or credentials."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vector_upgrade', ROOT / 'scripts/vector-upgrade.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
CURRENT = {'installed': '0.8.5', 'target': '0.8.6', 'update_required': True,
           'maintenance_pending': False, 'application_login': True,
           'database_oid': '42', 'cluster_sha256': 'a'*64, 'scope': 'SQL only'}


class VectorUpgradeTests(unittest.TestCase):
    def test_stable_versions_only(self):
        self.assertLess(v.version('0.8.5'), v.version('0.8.6'))
        for bad in [None, 'latest', '0.8.6;DROP', '1.2', 'v0.8.6', '0.8.6-beta', "0.8.6'", ' 0.8.6']:
            with self.assertRaises(RuntimeError):
                v.version(bad)

    def test_confirmation_precedes_any_database_access(self):
        with patch.object(v, 'plan') as plan:
            with self.assertRaises(RuntimeError):
                v.upgrade('0.8.5')
            plan.assert_not_called()

    def test_stale_version_never_fences_logins(self):
        with patch.object(v, 'plan', return_value=CURRENT), patch.object(v, 'execute') as execute, patch.object(v, 'marker_write') as marker:
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                v.upgrade('0.8.4', True)
            execute.assert_not_called()
            marker.assert_not_called()

    def test_operator_disabled_login_is_not_overridden(self):
        with patch.object(v, 'plan', return_value={**CURRENT, 'application_login': False}), patch.object(v, 'execute') as execute:
            with self.assertRaisesRegex(RuntimeError, 'already disabled'):
                v.upgrade('0.8.5', True)
            execute.assert_not_called()

    def test_pending_crash_marker_requires_explicit_recovery(self):
        with patch.object(v, 'plan', return_value={**CURRENT, 'maintenance_pending': True}), patch.object(v, 'execute') as execute:
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                v.upgrade('0.8.5', True)
            execute.assert_not_called()

    def test_noop_never_writes_or_creates_a_backup(self):
        with patch.object(v, 'plan', return_value={**CURRENT, 'installed': '0.8.6', 'update_required': False}), patch.object(v, 'execute') as execute, patch.object(v, 'capture_backup') as backup:
            self.assertFalse(v.upgrade('0.8.6', True)['changed'])
            execute.assert_not_called()
            backup.assert_not_called()

    def test_active_session_failure_restores_logins_without_termination(self):
        with patch.object(v, 'plan', return_value=CURRENT), patch.object(v, 'marker_write'), patch.object(v, 'marker_remove') as remove, patch.object(v, 'execute') as execute, patch.object(v, 'ensure_idle', side_effect=RuntimeError('clients connected')), patch.object(v, 'capture_backup') as backup:
            with self.assertRaisesRegex(RuntimeError, 'clients connected'):
                v.upgrade('0.8.5', True)
            self.assertEqual([c.args[0] for c in execute.call_args_list], ['ALTER ROLE ultrabrain NOLOGIN', 'ALTER ROLE ultrabrain LOGIN'])
            backup.assert_not_called()
            remove.assert_called_once()

    def test_lost_fencing_response_still_restores_previous_login(self):
        with patch.object(v, 'plan', return_value=CURRENT), patch.object(v, 'marker_write'), patch.object(v, 'marker_remove'), patch.object(v, 'execute', side_effect=[OSError('connection interrupted after commit'), '']) as execute:
            with self.assertRaises(OSError):
                v.upgrade('0.8.5', True)
            self.assertEqual(execute.call_args_list[-1].args[0], 'ALTER ROLE ultrabrain LOGIN')

    def test_failed_login_recovery_keeps_marker_for_operator(self):
        with patch.object(v, 'plan', return_value=CURRENT), patch.object(v, 'marker_write'), patch.object(v, 'marker_remove') as remove, patch.object(v, 'execute', side_effect=['', OSError('cannot restore login')]), patch.object(v, 'ensure_idle', side_effect=RuntimeError('client')):
            with self.assertRaises(OSError):
                v.upgrade('0.8.5', True)
            remove.assert_not_called()

    def test_recovery_refuses_wrong_database_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'marker.json'
            path.write_text(json.dumps({'format': 1, 'operation': 'vector-sql-upgrade', 'previous_login': True, 'database_oid': 'other', 'cluster_sha256': 'a'*64}))
            path.chmod(0o600)
            with patch.object(v, 'marker_path', return_value=path), patch.object(v, 'identity', return_value=CURRENT), patch.object(v, 'execute') as execute:
                with self.assertRaisesRegex(RuntimeError, 'does not identify'):
                    v.recover(True)
                execute.assert_not_called()
                self.assertTrue(path.exists())


if __name__ == '__main__':
    unittest.main()
