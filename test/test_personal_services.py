"""Synthetic unit rendering and installation only; no real user services are altered."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('personal_service',Path(__file__).resolve().parents[1]/'scripts/install-service.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
class Rendering(unittest.TestCase):
    def render(self,**opts):return s.render_personal(Path('/source'),Path('/private'),Path('/bin/bun'),Path('/bin/python3'),**opts)
    def test_default_does_not_enable_http_worker_or_model(self):
        u=self.render();self.assertEqual(set(u),{'ultrabrain-postgres.service','ultrabrain-personal-console.service','ultrabrain-personal.target'})
        self.assertNotIn('--allow-model-call',''.join(u.values()));self.assertNotIn('--http',''.join(u.values()))
    def test_legacy_database_unit_byte_equal(self):
        self.assertEqual(self.render()['ultrabrain-postgres.service'],s.render(Path('/source'),Path('/private'),Path('/bin/bun'),Path('/bin/python3'))['ultrabrain-postgres.service'])
    def test_existing_render_unchanged(self):
        self.assertEqual(set(s.render(Path('/source'),Path('/private'),Path('/bin/bun'),Path('/bin/python3'))),{'ultrabrain-postgres.service','ultrabrain-mcp.service'})
    def test_http_optional_loopback_not_legacy_unit_override(self):
        u=self.render(http_port=4000);self.assertIn('--bind 127.0.0.1 --port 4000 --suppress-bootstrap-token',u['ultrabrain-personal-mcp.service'])
        self.assertNotIn('ultrabrain-mcp.service',u);self.assertNotIn('0.0.0.0',''.join(u.values()))
    def test_schedule_requires_separate_consent(self):
        for opts in [{'interval':300},{'allow_model_call':True},{'batch_limit':2},{'interval':0,'allow_model_call':True},{'interval':True,'allow_model_call':True}]:
            with self.assertRaises(ValueError):self.render(**opts)
    def test_schedule_waits_after_completion_and_does_not_retry(self):
        u=self.render(interval=300,allow_model_call=True,batch_limit=4);worker=u['ultrabrain-personal-worker.service'];timer=u['ultrabrain-personal-worker.timer']
        self.assertIn('--allow-model-call --limit 4',worker);self.assertIn('Type=oneshot',worker)
        for flag in ['--loop','--retry','Restart=on-failure']:self.assertNotIn(flag,worker)
        self.assertIn('OnActiveSec=300s',timer);self.assertIn('OnUnitInactiveSec=300s',timer);self.assertIn('Persistent=false',timer)
    def test_stop_target_controls_only_personal_processes_not_database(self):
        u=self.render(interval=30,allow_model_call=True,http_port=4000)
        for name,text in u.items():
            if name.endswith('.target') or name=='ultrabrain-postgres.service':continue
            self.assertIn('PartOf=ultrabrain-personal.target',text)
        self.assertNotIn('PartOf=ultrabrain-personal.target',u['ultrabrain-postgres.service'])
    def test_argument_boundaries_and_fixed_home(self):
        u=s.render_personal(Path('/source $HOME %i space'),Path('/private $HOME %i'),Path('/bin/bun'),Path('/bin/python3'))
        c=u['ultrabrain-personal-console.service'];self.assertIn('/usr/bin/env "ULTRABRAIN_HOME=/private $$HOME %%i"',c)
        self.assertIn('personal-ui --source default --port 3132',c);self.assertNotIn('ExecStartPre=',c)
    def test_readers_restart_but_never_migrate_or_repair(self):
        c=self.render()['ultrabrain-personal-console.service'];self.assertIn('Restart=on-failure',c);self.assertNotIn(' migrate',c);self.assertNotIn(' bootstrap',c)
    def test_source_and_port_injection_refused(self):
        for opts in [{'source':'x\nExecStart=/evil'},{'source':'../x'},{'source':'UPPER'},{'source':''},{'console_port':80},{'console_port':True},{'http_port':3132},{'http_port':0},{'interval':86401,'allow_model_call':True},{'batch_limit':5}]:
            with self.assertRaises(ValueError):self.render(**opts)
    def test_relative_path_refused(self):
        with self.assertRaises(ValueError):s.render_personal(Path('source'),Path('/private'),Path('/bin/bun'),Path('/bin/python3'))
class Installation(unittest.TestCase):
    def setUp(self):
        mask=os.umask(0o077);self.addCleanup(os.umask,mask)
        self.temp=tempfile.TemporaryDirectory(prefix='ub-unit-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.target=self.root/'units';self.units={'ultrabrain-personal.target':'[Unit]\nDescription=synthetic\n'}
    def test_private_atomic_create_idempotent_no_model_execution(self):
        with patch.object(s.subprocess,'run') as run:
            first=s.write_units(self.target,self.units);second=s.write_units(self.target,self.units)
        self.assertEqual(first['changed'],list(self.units));self.assertEqual(second['changed'],[]);run.assert_not_called()
        p=self.target/'ultrabrain-personal.target';self.assertEqual(p.stat().st_mode&0o777,0o600);self.assertEqual(p.stat().st_nlink,1)
    def test_existing_different_content_refused_before_any_unit_write(self):
        s.write_units(self.target,self.units);before=list(self.target.iterdir())
        with self.assertRaises(ValueError):s.write_units(self.target,{'ultrabrain-other.service':'new',**{'ultrabrain-personal.target':'different'}})
        self.assertFalse((self.target/'ultrabrain-other.service').exists());self.assertEqual((self.target/'ultrabrain-personal.target').read_text(),self.units['ultrabrain-personal.target'])
    def test_explicit_replace_preserves_exact_old_bytes_and_hashes(self):
        s.write_units(self.target,self.units);r=s.write_units(self.target,{'ultrabrain-personal.target':'new\r\n'},True)
        backup=Path(r['backup_directory']);self.assertEqual((backup/'ultrabrain-personal.target').read_bytes(),self.units['ultrabrain-personal.target'].encode());self.assertEqual(backup.stat().st_mode&0o777,0o700)
        self.assertIn('ultrabrain-personal.target',json.loads((backup/'manifest.json').read_text())['before'])
    def test_symlinked_parent_and_leaf_refused(self):
        real=self.root/'real';real.mkdir();link=self.root/'linked';link.symlink_to(real,target_is_directory=True)
        with self.assertRaises(OSError):s.write_units(link/'units',self.units)
        self.assertEqual(list(real.iterdir()),[])
        s.write_units(self.target,self.units);p=self.target/'ultrabrain-personal.target';p.unlink();p.symlink_to(self.root/'not-created')
        with self.assertRaises(OSError):s.write_units(self.target,self.units,True)
        self.assertFalse((self.root/'not-created').exists())
    def test_fifo_hardlink_directory_and_writable_unit_refused(self):
        self.target.mkdir(mode=0o700);p=self.target/'ultrabrain-personal.target'
        os.mkfifo(p)
        with self.assertRaises(ValueError):s.write_units(self.target,self.units,True)
        p.unlink();p.mkdir()
        with self.assertRaises(ValueError):s.write_units(self.target,self.units,True)
        p.rmdir();original=self.root/'file';original.write_text('original');os.link(original,p)
        with self.assertRaises(ValueError):s.write_units(self.target,self.units,True)
        p.unlink();p.write_text('original');p.chmod(0o666)
        with self.assertRaises(ValueError):s.write_units(self.target,self.units,True)
    def test_external_content_conflict_is_not_overwritten(self):
        s.write_units(self.target,self.units);original=s.new_unit
        def interfere(fd,name,data):
            if name.startswith('.ultrabrain-unit-'):(self.target/'ultrabrain-personal.target').write_text('concurrent')
            return original(fd,name,data)
        with patch.object(s,'new_unit',side_effect=interfere):
            with self.assertRaises(ValueError):s.write_units(self.target,{'ultrabrain-personal.target':'changed'},True)
        self.assertEqual((self.target/'ultrabrain-personal.target').read_text(),'concurrent')
    def test_directory_swap_before_write_refused(self):
        s.write_units(self.target,self.units);original=s.new_unit;renamed=self.root/'moved'
        def interfere(fd,name,data):
            if name.startswith('.ultrabrain-unit-'):
                self.target.rename(renamed);self.target.mkdir(mode=0o700)
            return original(fd,name,data)
        with patch.object(s,'new_unit',side_effect=interfere):
            with self.assertRaises(ValueError):s.write_units(self.target,{'ultrabrain-personal.target':'new'},True)
        self.assertFalse((self.target/'ultrabrain-personal.target').exists())
    def test_installer_lock_not_stolen_or_followed(self):
        import fcntl
        self.target.mkdir(mode=0o700);p=self.target/'.ultrabrain-service-install.lock';p.write_text('')
        with p.open() as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):s.write_units(self.target,self.units)
        p.unlink();p.symlink_to(self.root/'nope')
        with self.assertRaises(OSError):s.write_units(self.target,self.units)
    def test_names_and_size_limits(self):
        for units in [{'../escape.service':'x'},{'ultrabrain-x.service':'x'*65537},{'sshd.service':'x'},{}]:
            with self.assertRaises(ValueError):s.write_units(self.target,units)
        self.assertFalse(self.target.exists())
class Reconfiguration(unittest.TestCase):
    def test_checks_every_personal_component(self):
        from types import SimpleNamespace
        with patch.object(s.subprocess,'run',return_value=SimpleNamespace(returncode=3,stdout='inactive\n')) as run:
            s.require_inactive(s.PERSONAL_COMPONENTS)
        self.assertEqual([c.args[0][-1] for c in run.call_args_list],list(s.PERSONAL_COMPONENTS))
    def test_active_child_or_ambiguous_error_is_not_inactive(self):
        from types import SimpleNamespace
        for code,text in [(0,'active'),(0,'activating'),(3,''),(3,'error'),(1,'inactive'),(4,'Cannot connect')]:
            with patch.object(s.subprocess,'run',return_value=SimpleNamespace(returncode=code,stdout=text)):
                with self.assertRaises(ValueError):s.require_inactive(s.PERSONAL_COMPONENTS)
    def test_stopped_or_missing_components_are_accepted(self):
        from types import SimpleNamespace
        for code,text in [(3,'inactive'),(3,'failed'),(4,'unknown')]:
            with patch.object(s.subprocess,'run',return_value=SimpleNamespace(returncode=code,stdout=text)):
                s.require_inactive(s.PERSONAL_COMPONENTS)
    def test_changed_database_unit_requires_database_stop(self):
        with tempfile.TemporaryDirectory(prefix='ub-guard-') as temp:
            path=Path(temp); units={'ultrabrain-postgres.service':'old'}; s.write_units(path,units)
            with patch.object(s,'require_inactive') as guard:
                s.reconfiguration_guard(path,units)
            self.assertEqual(guard.call_count,1)
            with patch.object(s,'require_inactive') as guard:
                s.reconfiguration_guard(path,{'ultrabrain-postgres.service':'new'})
            self.assertEqual(guard.call_args_list[-1].args[0],('ultrabrain-postgres.service',))
    def test_personal_paths_reject_systemd_ambiguous_characters(self):
        for path in ['/s"quote','/s\\slash','/s\nline','/s\x7fdelete','/s ']:
            with self.assertRaises(ValueError):s.render_personal(Path(path),Path('/home'),Path('/bin/bun'),Path('/bin/python3'))

if __name__=='__main__':unittest.main()
