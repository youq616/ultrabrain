"""Synthetic file safety tests; fake dumps are never called database validation."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recovery', ROOT / 'scripts/recovery.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.umask = os.umask(0o077); self.addCleanup(os.umask, self.umask)
        self.tmp = tempfile.TemporaryDirectory(prefix='ub-recovery-unit-'); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.home = self.root / 'home'; self.home.mkdir(mode=0o700)
        self.target = self.root / 'set'; self.staged = self.root / 'staged'
        for name in ('postgres', 'gbrain/.gbrain', 'gbrain/attachments/empty'):
            (self.home / name).mkdir(mode=0o700, parents=True, exist_ok=True)
        self.raw = b'\xef\xbb\xbf\xe4\xb8\xad\xe6\x96\x87\r\nDO_NOT_LOG_SECRET\0binary'
        for name, raw in {'postgres/state.json': b'{"synthetic_password":"DO_NOT_LOG_SECRET"}',
                          'postgres/runtime.json': b'{}', 'gbrain/.gbrain/config.json': b'{}',
                          'gbrain/attachments/blob': self.raw, 'service.env': b'MODEL_TOKEN=SYNTHETIC_ONLY\n'}.items():
            (self.home / name).write_bytes(raw)
        self.runtime = {'version': '18.6', 'postgres_revision': 'a'*40, 'pgvector_revision': 'b'*40, 'directory': 'synthetic'}
        self.pg = SimpleNamespace(HOME=self.home, LOCK={'synthetic': True}, compatible=Mock(),
            read_runtime=lambda: self.runtime, pg=Mock(return_value=SimpleNamespace(stdout='0\n')), restore_new=Mock())
        self.pg.backup = self.dump
        self.fingerprint = patch.object(r, 'app_fingerprint', return_value='c'*64)
        self.fingerprint.start(); self.addCleanup(self.fingerprint.stop)
    def dump(self, destination):
        path = Path(destination); path.mkdir(mode=0o700)
        (path / 'database.dump').write_bytes(b'FAKE_DUMP_NOT_A_DATABASE')
        (path / 'manifest.json').write_bytes(r.encoded({'kind':'database-only', 'format':2,
            'postgres':self.runtime, 'dump_sha256': hashlib.sha256(b'FAKE_DUMP_NOT_A_DATABASE').hexdigest()}))
    def create(self):
        return r.create(self.pg, self.target, consent=True, writers_stopped=True)['manifest_sha256']
    def rewrite_manifest(self, modify):
        path = self.target / 'manifest.json'; m = json.loads(path.read_bytes()); modify(m)
        path.write_bytes(r.encoded(m)); return hashlib.sha256(path.read_bytes()).hexdigest()
    def test_roundtrip_byte_exact_and_empty_directory(self):
        sha = self.create(); m = r.verify(self.target, sha)
        with patch.object(r, 'manager', return_value=self.pg):
            result = r.stage(self.target, self.staged, sha)
        self.assertFalse(result['configuration_applied']); self.assertFalse(result['services_started'])
        for row in m['private_files']:
            self.assertEqual((self.home/row['path']).read_bytes(), (self.staged/'private-state'/row['path']).read_bytes())
            self.assertEqual((self.staged/'private-state'/row['path']).stat().st_mode & 0o777, 0o600)
        self.assertTrue((self.staged/'private-state/gbrain/attachments/empty').is_dir())
        self.assertFalse((self.staged/'INCOMPLETE').exists())
        self.assertEqual(self.pg.restore_new.call_count, 0)
    def test_consent_before_creation(self):
        for kwargs in ({}, {'consent': True}, {'writers_stopped': True}):
            with self.assertRaisesRegex(r.RecoveryError, 'consent'): r.create(self.pg,self.target,**kwargs)
        self.assertFalse(self.target.exists()); self.pg.compatible.assert_not_called()
    def test_connected_client_refused(self):
        self.pg.pg.return_value.stdout = '1\n'
        with self.assertRaisesRegex(r.RecoveryError,'stop_application'): self.create()
        self.assertFalse(self.target.exists())
    def test_missing_core_config_refused(self):
        (self.home/'gbrain/.gbrain/config.json').unlink()
        with self.assertRaisesRegex(r.RecoveryError,'missing_private'): self.create()
        self.assertFalse(self.target.exists())
    def test_no_overwrite(self):
        self.create(); original=(self.target/'manifest.json').read_bytes()
        with self.assertRaises(FileExistsError): self.create()
        self.assertEqual(original,(self.target/'manifest.json').read_bytes())
    def test_destination_in_source_refused(self):
        with self.assertRaisesRegex(r.RecoveryError,'overlapping_destination'):
            r.create(self.pg,self.home/'bad-set',consent=True,writers_stopped=True)
    def test_source_symlink_and_hardlink_refused(self):
        path=self.home/'gbrain/attachments/blob'; path.unlink(); path.symlink_to(self.home/'postgres/state.json')
        with self.assertRaises(OSError): self.create()
        path.unlink(); os.link(self.home/'postgres/state.json',path)
        self.target=self.root/'set2'
        with self.assertRaisesRegex(r.RecoveryError,'unsafe_file'): self.create()
    def test_symlinked_native_directory_refused(self):
        (self.home/'gbrain/outside').symlink_to(self.root,target_is_directory=True)
        with self.assertRaisesRegex(r.RecoveryError,'unsafe_directory'): self.create()
    def test_link_swap_at_open_refused(self):
        original=os.open; swapped=False
        def changed(path,flags,*a,**kw):
            nonlocal swapped
            if path=='blob' and not swapped:
                swapped=True; p=self.home/'gbrain/attachments/blob'; p.unlink();p.symlink_to(self.home/'postgres/state.json')
            return original(path,flags,*a,**kw)
        with patch.object(r.os,'open',side_effect=changed):
            with self.assertRaises(OSError): self.create()
    def test_source_changes_during_dump_leave_incomplete_set(self):
        def changed(path): self.dump(path); (self.home/'service.env').write_bytes(b'changed')
        self.pg.backup=changed
        with self.assertRaisesRegex(r.RecoveryError,'private_state_changed'): self.create()
        self.assertTrue((self.target/'INCOMPLETE').is_file())
        with self.assertRaisesRegex(r.RecoveryError,'incomplete_set'): r.verify(self.target,'a'*64)
    def test_new_file_during_dump_refused(self):
        def changed(path): self.dump(path); (self.home/'gbrain/new').write_bytes(b'new')
        self.pg.backup=changed
        with self.assertRaisesRegex(r.RecoveryError,'source_inventory_changed'): self.create()
    def test_missing_or_wrong_external_manifest_pin(self):
        sha=self.create()
        for bad in (None,'','invalid','a'*64):
            with self.assertRaises(r.RecoveryError): r.verify(self.target,bad)
        self.assertTrue(r.verify(self.target,sha))
    def test_changed_bytes_rejected_before_restore(self):
        sha=self.create();(self.target/'database/database.dump').write_bytes(b'changed')
        with self.assertRaises(r.RecoveryError):r.restore_database(self.pg,self.target,sha,'ub_restore_fixture',True)
        self.pg.restore_new.assert_not_called()
    def test_private_object_corruption_refused(self):
        sha=self.create();(self.target/'private/000000.bin').write_bytes(b'changed')
        with self.assertRaises(r.RecoveryError):r.verify(self.target,sha)
    def test_path_traversal_unmanaged_paths_refused_even_with_new_digest(self):
        self.create()
        for name in ('../escape','/absolute','gbrain/../escape','gbrain//bad','gbrain/./bad','postgres/data/evil','gbrain/a:b','gbrain/evil\\file','gbrain/a\nfile'):
            sha=self.rewrite_manifest(lambda m:m['private_files'][0].update(path=name))
            with self.assertRaises(r.RecoveryError):r.verify(self.target,sha)
        self.assertFalse((self.root/'escape').exists())
    def test_extra_missing_and_linked_backup_objects_refused(self):
        sha=self.create(); obj=self.target/'private/extra';obj.write_bytes(b'not in manifest')
        with self.assertRaisesRegex(r.RecoveryError,'unexpected'):r.verify(self.target,sha)
        obj.unlink(); p=self.target/'private/000000.bin';raw=p.read_bytes();p.unlink();p.symlink_to(self.home/'service.env')
        with self.assertRaises(OSError):r.verify(self.target,sha)
        p.unlink()
        with self.assertRaises(OSError):r.verify(self.target,sha)
    def test_incomplete_database_rejected(self):
        sha=self.create();(self.target/'database/INCOMPLETE').write_bytes(b'bad')
        with self.assertRaisesRegex(r.RecoveryError,'unexpected_database'):r.verify(self.target,sha)
    def test_database_manifest_consistency_required(self):
        self.create();sha=self.rewrite_manifest(lambda m:m.update(postgres={'version':'99.1'}))
        with self.assertRaisesRegex(r.RecoveryError,'database_manifest_mismatch'):r.verify(self.target,sha)
    def test_duplicate_paths_or_object_mapping_refused(self):
        self.create();sha=self.rewrite_manifest(lambda m:m['private_files'][1].update(path=m['private_files'][0]['path']))
        with self.assertRaises(r.RecoveryError):r.verify(self.target,sha)
    def test_resource_limits_do_not_evict_or_truncate(self):
        with patch.object(r,'MAX_FILES',1):
            with self.assertRaisesRegex(r.RecoveryError,'file_count_limit'):self.create()
        with patch.object(r,'MAX_BYTES',1):
            with self.assertRaisesRegex(r.RecoveryError,'size_limit'):self.create()
        self.assertEqual((self.home/'gbrain/attachments/blob').read_bytes(),self.raw)
    def test_no_restore_without_trust_even_valid_hash(self):
        sha=self.create()
        with self.assertRaisesRegex(r.RecoveryError,'backup_origin_trust'):r.restore_database(self.pg,self.target,sha,'ub_restore_safe')
        self.pg.restore_new.assert_not_called()
    def test_primary_or_sql_identifier_refused(self):
        sha=self.create()
        for db in ('ultrabrain','postgres','ub_restore_x;DROP DATABASE ultrabrain'):
            with self.assertRaisesRegex(r.RecoveryError,'invalid_restore_database'):r.restore_database(self.pg,self.target,sha,db,True)
        self.pg.restore_new.assert_not_called()
    def test_changed_code_or_runtime_refused_before_restore(self):
        sha=self.create()
        with patch.object(r,'app_fingerprint',return_value='d'*64):
            with self.assertRaisesRegex(r.RecoveryError,'runtime_mismatch'):r.restore_database(self.pg,self.target,sha,'ub_restore_safe',True)
        self.pg.restore_new.assert_not_called()
    def test_restore_only_private_verified_copy_and_not_old_configuration(self):
        sha=self.create(); before=(self.home/'postgres/state.json').read_bytes()
        def restore(path,db):
            self.assertNotEqual(Path(path),self.target/'database');self.assertEqual(db,'ub_restore_fixture')
            self.assertEqual((Path(path)/'database.dump').read_bytes(),b'FAKE_DUMP_NOT_A_DATABASE')
        self.pg.restore_new.side_effect=restore
        out=r.restore_database(self.pg,self.target,sha,'ub_restore_fixture',True)
        self.assertFalse(out['configuration_applied']);self.assertEqual((self.home/'postgres/state.json').read_bytes(),before)
    def test_failed_restore_not_relabelled_success(self):
        sha=self.create();self.pg.restore_new.side_effect=RuntimeError('synthetic failed restore')
        with self.assertRaises(RuntimeError):r.restore_database(self.pg,self.target,sha,'ub_restore_fixture',True)
    def test_report_never_contains_secret_text(self):
        output=io.StringIO()
        with patch.object(r,'manager',return_value=self.pg),patch.object(r.os,'geteuid',return_value=123456),contextlib.redirect_stdout(output):
            # This user deliberately does not own the directory, so only a safe code is output.
            code=r.main(['create','--destination',str(self.target),'--include-private-state','--writers-stopped'])
        self.assertEqual(code,1);self.assertNotIn('DO_NOT_LOG',output.getvalue());self.assertNotIn(str(self.home),output.getvalue())
    def test_stage_does_not_execute_database_commands(self):
        sha=self.create();self.pg.pg.reset_mock()
        with patch.object(r,'manager',return_value=self.pg):r.stage(self.target,self.staged,sha)
        self.pg.pg.assert_not_called();self.pg.restore_new.assert_not_called()
    def test_manager_lock_cannot_be_symlink_or_stolen(self):
        lock=self.home/'.postgres-manager.lock';lock.symlink_to(self.home/'service.env')
        with self.assertRaises(OSError):self.create()
        lock.unlink()
        with r.managed_lock(self.pg):
            with self.assertRaises(BlockingIOError):self.create()
    def test_manifest_duplicate_keys_rejected(self):
        with self.assertRaisesRegex(r.RecoveryError,'duplicate_key'):r.load_json(b'{"format":1,"format":2}')

if __name__=='__main__':unittest.main()
