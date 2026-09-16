"""Temporary plans only; no service installation or actual models in these unit tests."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('personal_services', ROOT/'scripts/personal-services.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class PersonalServicesTests(unittest.TestCase):
    def setUp(self):
        old = os.umask(0o077); self.addCleanup(os.umask, old)
        tmp = tempfile.TemporaryDirectory(prefix='ub-personal-services-'); self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.output = self.root/'export'
        self.home = self.root/'not-created'
        self.value = m.plan(ROOT, self.home, '/usr/bin/bun')
    def export(self, value=None):
        value = value or self.value
        return m.export_plan(value, self.output, value['plan_sha256'])
    def test_default_contains_no_worker_or_model_permission(self):
        self.assertEqual(set(self.value['units']), {m.TARGET, m.CONSOLE})
        self.assertNotIn('--allow-model-call', json.dumps(self.value))
        self.assertFalse(self.value['worker_enabled_in_plan']); self.assertFalse(self.home.exists())
    def test_worker_requires_two_explicit_flags(self):
        for values in ({'worker': True}, {'allow_model_call': True}):
            with self.assertRaisesRegex(m.ServicePlanError, 'consent'): m.plan(ROOT,self.home,'/bin/bun',**values)
        v=m.plan(ROOT,self.home,'/bin/bun',worker=True,allow_model_call=True)
        self.assertIn(m.WORKER,v['units']); text=v['units'][m.WORKER]
        self.assertIn('RestartPreventExitStatus=2', text)
        self.assertIn('"--limit" "1"',text); self.assertNotIn('"--retry"',text)
    def test_plan_is_deterministic_and_covers_source_and_flags(self):
        self.assertEqual(self.value,m.plan(ROOT,self.home,'/usr/bin/bun'))
        for kwargs in ({'source':'other'}, {'port':4000}, {'worker':True,'allow_model_call':True}):
            self.assertNotEqual(self.value['plan_sha256'],m.plan(ROOT,self.home,'/usr/bin/bun',**kwargs)['plan_sha256'])
    def test_bad_identifiers_and_port_ranges_refused(self):
        for value in ('../a','x\nExecStart=evil','UPPER','*','a'*33):
            with self.assertRaises(m.ServicePlanError): m.plan(ROOT,self.home,'/bin/bun',source=value)
        for value in (0,1023,65536,True,'3132'):
            with self.assertRaises(m.ServicePlanError): m.plan(ROOT,self.home,'/bin/bun',port=value)
        for value in (29,86401,True):
            with self.assertRaises(m.ServicePlanError):m.plan(ROOT,self.home,'/bin/bun',interval=value)
    def test_controls_relative_and_ambiguous_paths_refused(self):
        for value in ('relative','/','/a/../b','/a//b','/a/','/a\nfoo','/a\x7ffoo'):
            with self.assertRaises(m.ServicePlanError):m.plan(value,self.home,'/bin/bun')
    def test_expansion_and_shell_characters_are_literal(self):
        text=m.plan('/srv/中文 %n $X "dir"', '/home/中文 $KEY', '/bin/bu%n')['units'][m.CONSOLE]
        self.assertIn('%%n', text); self.assertIn('$$X', text); self.assertIn('\\"dir\\"', text)
        self.assertIn('WorkingDirectory=/\n',text)
        self.assertNotIn('/bin/sh',text); self.assertNotIn('EnvironmentFile=',text)
    def test_stable_environment_before_execution_and_no_dotenv(self):
        text=self.value['units'][m.CONSOLE]
        self.assertIn('"ULTRABRAIN_HOME='+str(self.home)+'"',text)
        self.assertIn('"GBRAIN_SOURCE=default"',text)
        self.assertIn('"--no-env-file"',text)
        self.assertIn('"-u" "NODE_OPTIONS"',text)
        self.assertIn('"ULTRABRAIN_MCP_PROFILE=compatibility"',text)
    def test_shutdown_order_and_local_only_console(self):
        text=self.value['units'][m.CONSOLE]
        self.assertIn('PartOf='+m.TARGET+' '+m.DATABASE,text)
        self.assertIn('After='+m.DATABASE,text); self.assertIn('KillMode=control-group',text)
        self.assertNotIn('0.0.0.0',text); self.assertNotIn('--http',text)
        self.assertNotIn(m.DATABASE,self.value['units'])
    def test_export_exact_private_files_and_verify(self):
        r=self.export(); self.assertTrue(r['exported']);self.assertFalse(r['installed'])
        self.assertEqual(set(os.listdir(self.output)),{*self.value['units'],'manifest.json'})
        self.assertFalse((self.output/'INCOMPLETE').exists())
        for name,text in self.value['units'].items():
            self.assertEqual((self.output/name).read_bytes(),text.encode())
            self.assertEqual((self.output/name).stat().st_mode & 0o777,0o600)
        self.assertTrue(m.verify_export(self.value,self.output,self.value['plan_sha256'])['verified'])
        self.assertFalse(self.home.exists())
    def test_wrong_plan_before_writing(self):
        with self.assertRaisesRegex(m.ServicePlanError,'reviewed_plan'): m.export_plan(self.value,self.output,'0'*64)
        self.assertFalse(self.output.exists())
    def test_mutated_plan_cannot_use_an_old_review_hash(self):
        self.value['units'][m.CONSOLE] += '# changed after review\n'
        with self.assertRaisesRegex(m.ServicePlanError,'reviewed_plan'):self.export()
        self.assertFalse(self.output.exists())
    def test_output_never_overwrites_even_empty_directory(self):
        self.output.mkdir(mode=0o700)
        with self.assertRaises(FileExistsError):self.export()
        self.assertEqual(os.listdir(self.output),[])
    def test_existing_symlink_and_parent_links_refused(self):
        self.output.symlink_to(self.home)
        with self.assertRaises(FileExistsError):self.export()
        self.output.unlink(); alias=self.root/'alias';alias.symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(OSError):m.export_plan(self.value,alias/'other',self.value['plan_sha256'])
        self.assertFalse((self.root/'other').exists())
    def test_parent_permissions_not_silently_repaired(self):
        self.root.chmod(0o755)
        try:
            with self.assertRaisesRegex(m.ServicePlanError,'private_output_parent'):self.export()
            self.assertEqual(self.root.stat().st_mode & 0o777,0o755)
        finally:self.root.chmod(0o700)
    def test_write_failure_preserves_incomplete_evidence(self):
        original=m.write_file
        def fail(fd,name,raw):
            if name==m.CONSOLE:raise OSError('synthetic full disk')
            return original(fd,name,raw)
        with patch.object(m,'write_file',side_effect=fail):
            with self.assertRaises(OSError):self.export()
        self.assertTrue((self.output/'INCOMPLETE').exists())
        with self.assertRaises(m.ServicePlanError):m.verify_export(self.value,self.output,self.value['plan_sha256'])
    def test_renamed_output_not_relabelled_success(self):
        original=m.write_file
        def move(fd,name,raw):
            original(fd,name,raw)
            if name=='manifest.json':
                self.output.rename(self.root/'moved');self.output.mkdir(mode=0o700)
        with patch.object(m,'write_file',side_effect=move):
            with self.assertRaisesRegex(m.ServicePlanError,'output_path_changed'):self.export()
        self.assertTrue((self.root/'moved/INCOMPLETE').exists());self.assertEqual(os.listdir(self.output),[])
    def test_modified_extra_and_missing_units_refused(self):
        self.export();sha=self.value['plan_sha256'];p=self.output/m.CONSOLE;old=p.read_bytes()
        p.write_bytes(old+b'# modification')
        with self.assertRaises(m.ServicePlanError):m.verify_export(self.value,self.output,sha)
        p.write_bytes(old);extra=self.output/'other';extra.write_text('extra')
        with self.assertRaises(m.ServicePlanError):m.verify_export(self.value,self.output,sha)
        extra.unlink();p.unlink()
        with self.assertRaises(m.ServicePlanError):m.verify_export(self.value,self.output,sha)
    def test_manifest_modification_refused(self):
        self.export();path=self.output/'manifest.json';data=json.loads(path.read_bytes());data['services_started']=True;path.write_text(json.dumps(data))
        with self.assertRaises(m.ServicePlanError):m.verify_export(self.value,self.output,self.value['plan_sha256'])
    def test_unit_link_and_wide_permissions_refused(self):
        self.export();path=self.output/m.CONSOLE;path.chmod(0o644)
        with self.assertRaises(m.ServicePlanError):m.verify_export(self.value,self.output,self.value['plan_sha256'])
        path.unlink();path.symlink_to('/etc/passwd')
        with self.assertRaises(OSError):m.verify_export(self.value,self.output,self.value['plan_sha256'])
    def test_fifo_refused_without_waiting(self):
        self.export();p=self.output/m.CONSOLE;p.unlink();os.mkfifo(p,0o600)
        with self.assertRaises(m.ServicePlanError):m.verify_export(self.value,self.output,self.value['plan_sha256'])
    def test_real_systemd_parser_accepts_units_without_enabling(self):
        if not shutil.which('systemd-analyze'):self.skipTest('systemd parser not installed')
        self.export();check=self.root/'syntax';shutil.copytree(self.output,check)
        # Only a dependency stub for parser validation, never called a runtime DB test.
        (check/m.DATABASE).write_text('[Service]\nType=oneshot\nExecStart=/usr/bin/true\nRemainAfterExit=yes\n')
        p=subprocess.run(['systemd-analyze','verify',*[str(check/n) for n in self.value['units']]],capture_output=True,text=True,timeout=20)
        self.assertEqual(p.returncode,0,p.stderr)
    def test_cli_argument_error_does_not_echo_input(self):
        from contextlib import redirect_stdout
        from io import StringIO
        buf=StringIO()
        with redirect_stdout(buf):code=m.main(['--secret=SYNTHETIC_TOKEN'])
        self.assertEqual(code,1);self.assertNotIn('SYNTHETIC_TOKEN',buf.getvalue())
    def test_root_and_foreign_platform_refused(self):
        from contextlib import redirect_stdout
        from io import StringIO
        for k in ('root','platform'):
            buf=StringIO()
            with patch.object(m.os,'geteuid',return_value=0 if k=='root' else 1000),patch.object(m.sys,'platform','linux' if k=='root' else 'win32'),redirect_stdout(buf):code=m.main(['--bun','/bin/bun'])
            self.assertEqual(code,1);self.assertIn('ordinary_linux_account_required',buf.getvalue())

if __name__=='__main__':unittest.main()
