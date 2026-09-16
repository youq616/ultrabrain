"""Synthetic file/unit contracts, not a live systemd or database certification."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('personal_services',ROOT/'scripts/personal-services.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

class PersonalServiceTests(unittest.TestCase):
    def setUp(self):
        self.umask=os.umask(0o077);self.addCleanup(os.umask,self.umask)
        self.temp=tempfile.TemporaryDirectory(prefix='ub-personal-units-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.home=self.root/'home';self.repo=self.root/'repo'
        self.home.mkdir(mode=0o700);self.repo.mkdir(mode=0o700)
        self.settings=dict(root=str(self.repo),home=str(self.home),bun='/usr/bin/true',python=sys.executable,
                           source='default',name='ub-fixture')
        self.out=self.root/'bundle'
    def render(self,**kw):return s.render_units(**(self.settings|kw))
    def create(self,**kw):return s.generate(self.out,self.settings|kw,precheck=lambda *a,**k:{'ok':True})
    def test_console_only_default(self):
        units=self.render();self.assertEqual(list(units),['ub-fixture-console.service'])
        content=next(iter(units.values()));self.assertIn('personal-ui',content);self.assertNotIn('--allow-model-call',content)
        self.assertNotIn('EnvironmentFile=',content);self.assertNotIn('migrate',content)
    def test_two_independent_schedule_flags_required(self):
        for kw in ({'with_consolidation':True},{'allow_model_call':True},
                   {'with_consolidation':1,'allow_model_call':True}):
            with self.assertRaisesRegex(s.ServiceError,'consent'):self.render(**kw)
    def test_timer_uses_bounded_one_shot_not_infinite_retry(self):
        units=self.render(with_consolidation=True,allow_model_call=True,interval=30,limit=4)
        worker=units['ub-fixture-worker.service'];timer=units['ub-fixture-worker.timer']
        self.assertIn('Type=oneshot',worker);self.assertIn('Restart=no',worker)
        self.assertIn('RemainAfterExit=no',worker);self.assertIn('TimeoutStartSec=600',worker)
        self.assertNotIn('--loop',worker);self.assertNotIn('--retry',worker)
        self.assertIn('Persistent=false',timer);self.assertIn('OnUnitInactiveSec=30s',timer)
        self.assertNotIn('OnCalendar=',timer);self.assertIn('BindsTo=ultrabrain-postgres.service',timer)
    def test_invalid_source_never_becomes_unit_directive(self):
        for v in ('A','../x','x\nExecStart=/evil','x;false','x'*33,None):
            with self.subTest(v=v),self.assertRaises(s.ServiceError):self.render(source=v)
    def test_name_and_dependency_fences(self):
        for kw in ({'name':'../evil'},{'name':'a@b'},{'database_unit':'x.service\nWants=evil'},
                   {'database_unit':'ub-fixture-console.service'},{'database_unit':'ub-fixture-worker.service'},
                   {'database_unit':'x.socket'}):
            with self.subTest(kw=kw),self.assertRaises(s.ServiceError):self.render(**kw)
    def test_numeric_options_strict_and_bounded(self):
        for field,values in [('port',(True,1023,65536,'3132')),('interval',(True,29,86401)),('limit',(True,0,5))]:
            for value in values:
                with self.subTest(field=field,value=value),self.assertRaises(s.ServiceError):self.render(**{field:value})
    def test_path_injection_and_relative_paths_refused(self):
        for v in ('relative','/a/../b','/a\nb','/a\x7fb'):
            with self.assertRaises(s.ServiceError):self.render(home=v)
    def test_distinct_exec_and_unit_expansion_escaping(self):
        value='/absolute/a b/%n/$HOME/"quote"/\\part'
        self.assertIn('%%n',s.quote(value));self.assertIn('$$HOME',s.quote(value,True))
        self.assertIn('$HOME',s.quote(value));self.assertNotIn('$$HOME',s.quote(value))
    def test_roundtrip_units_private_and_inactive(self):
        result=self.create();verified=s.verify(self.out,result['manifest_sha256'])
        self.assertFalse(result['services_started']);self.assertFalse(result['models_called'])
        self.assertFalse(result['model_schedule_authorized']);self.assertTrue(verified['verified'])
        for p in self.out.iterdir():self.assertEqual(p.stat().st_mode&0o777,0o600)
        self.assertEqual(set(p.name for p in self.out.iterdir()),{'manifest.json','ub-fixture-console.service'})
    def test_consent_failure_precedes_preflight_or_output(self):
        with patch.object(s.pf,'run_local',side_effect=AssertionError('no external command')):
            with self.assertRaises(s.ServiceError):self.create(with_consolidation=True)
        self.assertFalse(self.out.exists())
    def test_failed_preflight_writes_nothing(self):
        with self.assertRaisesRegex(s.ServiceError,'preflight_failed'):
            s.generate(self.out,self.settings,precheck=lambda *a,**k:{'ok':False})
        self.assertFalse(self.out.exists())
    def test_existing_output_not_overwritten(self):
        first=self.create();old={p.name:p.read_bytes() for p in self.out.iterdir()}
        with self.assertRaises(FileExistsError):self.create(with_consolidation=True,allow_model_call=True)
        self.assertEqual(old,{p.name:p.read_bytes() for p in self.out.iterdir()})
        self.assertTrue(s.verify(self.out,first['manifest_sha256'])['verified'])
    def test_dangling_output_link_not_followed(self):
        self.out.symlink_to(self.root/'absent',target_is_directory=True)
        with self.assertRaises(FileExistsError):self.create()
        self.assertFalse((self.root/'absent').exists())
    def test_output_parent_links_refused(self):
        alias=self.root/'alias';alias.symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(OSError):s.generate(alias/'bundle',self.settings,precheck=lambda *a,**k:{'ok':True})
    def test_broad_parent_permissions_refused(self):
        self.root.chmod(0o755)
        try:
            with self.assertRaises(s.pf.PreflightError):self.create()
        finally:self.root.chmod(0o700)
    def test_overlapping_home_or_repository_refused(self):
        for path in (self.home,self.home/'nested',self.repo/'nested',self.root):
            with self.assertRaisesRegex(s.ServiceError,'overlaps'):
                s.generate(path,self.settings,precheck=lambda *a,**k:{'ok':True})
    def test_wrong_or_missing_manifest_pin_refused(self):
        result=self.create()
        for value in (None,'','abc','0'*64):
            with self.assertRaises(s.ServiceError):s.verify(self.out,value)
        self.assertTrue(s.verify(self.out,result['manifest_sha256'])['verified'])
    def test_unit_tampering_fails(self):
        result=self.create();(self.out/'ub-fixture-console.service').write_text('ExecStart=/evil\n')
        with self.assertRaisesRegex(s.ServiceError,'hash_mismatch'):s.verify(self.out,result['manifest_sha256'])
    def test_added_file_and_incomplete_marker_refused(self):
        result=self.create()
        for name in ('INCOMPLETE','foreign.service'):
            p=self.out/name;p.write_text('do not load')
            with self.assertRaisesRegex(s.ServiceError,'unexpected'):s.verify(self.out,result['manifest_sha256'])
            p.unlink()
    def test_deleted_unit_refused(self):
        result=self.create();(self.out/'ub-fixture-console.service').unlink()
        with self.assertRaisesRegex(s.ServiceError,'unexpected'):s.verify(self.out,result['manifest_sha256'])
    def test_bundle_unit_links_and_hardlinks_refused(self):
        result=self.create();p=self.out/'ub-fixture-console.service';raw=p.read_bytes();p.unlink()
        outside=self.root/'source.service';outside.write_bytes(raw);p.symlink_to(outside)
        with self.assertRaises(OSError):s.verify(self.out,result['manifest_sha256'])
        p.unlink();os.link(outside,p)
        with self.assertRaises(s.pf.PreflightError):s.verify(self.out,result['manifest_sha256'])
    def test_modified_manifest_not_authorized_by_old_pin(self):
        result=self.create();p=self.out/'manifest.json';p.write_bytes(p.read_bytes()+b' ')
        with self.assertRaisesRegex(s.ServiceError,'manifest_hash'):s.verify(self.out,result['manifest_sha256'])
    def test_manifest_cannot_add_arbitrary_execution_field(self):
        self.create();p=self.out/'manifest.json';data=json.loads(p.read_bytes());data['settings']['extra_command']='evil'
        raw=s.encode(data);p.write_bytes(raw)
        with self.assertRaisesRegex(s.ServiceError,'invalid_manifest'):s.verify(self.out,s.digest(raw))
    def test_failed_sync_retains_incomplete_marker(self):
        original=os.fsync;count=0
        def interrupted(fd):
            nonlocal count
            count+=1
            if count==2:raise OSError('synthetic disk failure')
            return original(fd)
        with patch.object(s.os,'fsync',side_effect=interrupted):
            with self.assertRaises(OSError):self.create()
        self.assertTrue((self.out/'INCOMPLETE').is_file())
    def test_cli_root_refused_without_reading_paths(self):
        out=io.StringIO()
        with patch.object(s.os,'geteuid',return_value=0),contextlib.redirect_stdout(out):
            code=s.main(['render','--output','/PRIVATE_SECRET','--source','default'])
        self.assertEqual(code,1);self.assertNotIn('PRIVATE_SECRET',out.getvalue())
    def test_unknown_cli_operation_never_echoes_private_input(self):
        out=io.StringIO()
        with patch.object(s.os,'geteuid',return_value=1000),contextlib.redirect_stdout(out):code=s.main(['enable-SECRET'])
        self.assertEqual(code,1);self.assertNotIn('enable-SECRET',out.getvalue())
    def test_no_model_flags_default_and_safe_diagnostics(self):
        result=self.create();self.assertNotIn('model_key',json.dumps(result));self.assertFalse(result['models_called'])
    def test_preflight_can_find_the_pinned_bun_in_nonstandard_directory(self):
        content=self.render(bun='/private/tool/bin/bun')['ub-fixture-console.service']
        self.assertIn('Environment="PATH=/private/tool/bin:',content)
        self.assertIn('PrivateUsers=true',content)
    def test_manifest_must_not_mislabel_model_authority(self):
        self.create(with_consolidation=True,allow_model_call=True)
        p=self.out/'manifest.json';m=json.loads(p.read_bytes());m['model_schedule_authorized']=False
        raw=s.encode(m);p.write_bytes(raw)
        with self.assertRaisesRegex(s.ServiceError,'invalid_manifest'):s.verify(self.out,s.digest(raw))
    def test_settings_snapshot_is_taken_before_preflight(self):
        def check(*a,**k):
            self.settings['source']='different'
            return {'ok':True}
        result=s.generate(self.out,self.settings,precheck=check)
        self.assertTrue(s.verify(self.out,result['manifest_sha256'])['verified'])
        self.assertIn('GBRAIN_SOURCE=default',(self.out/'ub-fixture-console.service').read_text())
    def test_ambiguous_backslash_colon_and_trailing_space_paths_refused(self):
        for p in ('/foo/bar ', '/foo/a:b', '/foo/a\\b'):
            with self.assertRaises(s.ServiceError):self.render(root=p)
    def test_actual_systemd_parser_accepts_quoted_units(self):
        analyzer=shutil.which('systemd-analyze')
        if not analyzer:self.skipTest('systemd-analyze unavailable; live CI still required')
        units=self.render(with_consolidation=True,allow_model_call=True,
                          root=str(self.repo/'space %n $NAME'),home=str(self.home/'space %n $NAME'))
        target=self.root/'syntax';target.mkdir()
        units['ultrabrain-postgres.service']='[Service]\nType=oneshot\nExecStart=/usr/bin/true\nRemainAfterExit=yes\n'
        for name,content in units.items():(target/name).write_text(content)
        completed=subprocess.run([analyzer,'verify',*[str(target/n) for n in units]],capture_output=True,text=True,timeout=20,
                                 env={**os.environ,'SYSTEMD_UNIT_PATH':str(target)+':','SYSTEMD_LOG_LEVEL':'warning'})
        self.assertEqual(completed.returncode,0,completed.stderr)

if __name__=='__main__':unittest.main()
