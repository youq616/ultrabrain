"""Offline preflight tests. Synthetic private files; no PostgreSQL/provider connection."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ultrabrain_preflight', ROOT/'scripts/preflight.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.old_mask = os.umask(0o077); self.addCleanup(os.umask, self.old_mask)
        self.tmp = tempfile.TemporaryDirectory(prefix='ub-preflight-test-'); self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name); self.repo = self.base/'repo'; self.repo.mkdir(mode=0o700)
        self.home = self.base/'home'; self.home.mkdir(mode=0o700)
        self.pins = {'projects':{'gbrain':{'revision':'a'*40}, 'postgres':{'version':'18.6','revision':'b'*40},
                                 'pgvector':{'revision':'c'*40}}}
        self.prefix = 'postgres-18.6-'+('b'*12)+'-pgvector-'+('c'*12)+'-portable-v1'
        (self.repo/'upstreams.lock.json').write_text(json.dumps(self.pins))
        self.state = {'port':6543,'admin_password':'SYNTHETIC_ADMIN_SECRET','app_password':'SYNTHETIC_AP P/SECRET%'}
        self.binding = {'version':'18.6','postgres_revision':'b'*40,'pgvector_revision':'c'*40,'directory':self.prefix}
        self.config = {'engine':'postgres','database_url':'postgresql://ultrabrain:'+quote(self.state['app_password'],safe='')+'@127.0.0.1:6543/ultrabrain',
                       'provider_key':'DO_NOT_REPORT_SYNTHETIC_PRIVATE_VALUE'}
        for path,data in {'postgres/state.json':self.state,'postgres/runtime.json':self.binding,
                          'gbrain/.gbrain/config.json':self.config}.items():
            self.put(path,json.dumps(data).encode())
        self.put('postgres/data/PG_VERSION',b'18\n')
        self.put('runtime/'+self.prefix+'/.ultrabrain-build',('b'*40+':'+'c'*40+'\n').encode())
        for name in m.RUNTIME_BINARIES:
            path=self.put('runtime/'+self.prefix+'/bin/'+name,b'SYNTHETIC_NOT_EXECUTED')
            path.chmod(0o700)
        path=self.repo/'vendor/gbrain/src/cli.ts';path.parent.mkdir(mode=0o700,parents=True);path.write_text('// synthetic')
        (self.repo/'vendor/gbrain/node_modules').mkdir(mode=0o700)
        self.probes=[]
        def probe(args,**kwargs):
            self.probes.append(args)
            self.assertTrue(args==['/trusted/bun','--version'] or args==['/trusted/pkg-config','--exists','openssl','zlib'])
            return b'1.3.13\n' if args[0].endswith('bun') else b''
        self.mock_probe=patch.object(m,'run_local',side_effect=probe);self.mock_probe.start();self.addCleanup(self.mock_probe.stop)
        self.mock_which=patch.object(m.shutil,'which',side_effect=lambda name:'/trusted/'+name);self.mock_which.start();self.addCleanup(self.mock_which.stop)
        self.mock_platform=patch.object(m.platform,'system',return_value='Linux');self.mock_platform.start();self.addCleanup(self.mock_platform.stop)
    def put(self,path,raw):
        target=self.home/path;target.parent.mkdir(parents=True,mode=0o700,exist_ok=True);target.write_bytes(raw);return target
    def run_check(self,mode='runtime',home=None):
        return m.preflight(mode,home if home is not None else self.home,root=self.repo)
    def item(self,result,name):
        return next(c for c in result['checks'] if c['id']==name)
    def snapshot(self):
        return {p.relative_to(self.home).as_posix():(p.read_bytes(),p.stat().st_mtime_ns,stat.S_IMODE(p.stat().st_mode))
                for p in self.home.rglob('*') if p.is_file()}
    def test_consistent_synthetic_installation_is_offline_not_live_certification(self):
        before=self.snapshot();r=self.run_check()
        self.assertTrue(r['ok']);self.assertFalse(r['live_service_verified']);self.assertFalse(r['database_connected'])
        self.assertFalse(r['model_called']);self.assertFalse(r['changes_made']);self.assertEqual(self.snapshot(),before)
        self.assertEqual(self.probes,[['/trusted/bun','--version']]);self.assertEqual(self.item(r,'live_database_and_mcp')['status'],'not_checked')
    def test_missing_planned_home_not_created(self):
        planned=self.base/'does-not-exist'/'nested';r=self.run_check('install',planned)
        self.assertTrue(r['ok']);self.assertFalse(planned.parent.exists())
        self.assertEqual(self.item(r,'installation')['code'],'not_installed_no_directory_created')
    def test_missing_runtime_home_fails_without_creation(self):
        planned=self.base/'missing';r=self.run_check('runtime',planned)
        self.assertFalse(r['ok']);self.assertFalse(planned.exists())
    def test_install_mode_does_not_read_existing_credentials(self):
        self.put('postgres/state.json',b'not JSON');r=self.run_check('install')
        self.assertTrue(r['ok']);self.assertNotIn('database_state',[c['id'] for c in r['checks']])
    def test_root_stops_before_inspection(self):
        with patch.object(m.os,'geteuid',return_value=0),patch.object(m,'PrivateHome',side_effect=AssertionError):
            r=self.run_check();self.assertFalse(r['ok']);self.assertFalse(self.probes)
    def test_windows_server_is_not_mislabelled_supported(self):
        with patch.object(m.platform,'system',return_value='Windows'),patch.object(m,'PrivateHome',side_effect=AssertionError):
            r=self.run_check();self.assertEqual(r['checks'][0]['code'],'server_requires_linux');self.assertFalse(self.probes)
    def test_python_version_floor(self):
        with patch.object(m.sys,'version_info',(3,10,99)):
            r=self.run_check();self.assertFalse(r['ok']);self.assertEqual(self.item(r,'python')['code'],'python_3_11_required')
    def test_bun_missing_is_safe_and_not_installed(self):
        with patch.object(m.shutil,'which',return_value=None):
            r=self.run_check();self.assertEqual(self.item(r,'bun')['code'],'bun_not_found');self.assertFalse(self.probes)
    def test_old_prerelease_and_untrusted_version_output_rejected(self):
        for raw in (b'1.3.10',b'1.3.13-canary',b'DO_NOT_REPORT_SYNTHETIC_PRIVATE_VALUE',b'1.3.13\nsecret'):
            with self.subTest(raw=raw),patch.object(m,'run_local',return_value=raw):
                r=self.run_check();self.assertFalse(r['ok']);self.assertNotIn('DO_NOT_REPORT',json.dumps(r))
    def test_stable_supported_bun_versions(self):
        for raw in (b'1.3.11',b'1.3.13\n',b'1.4.0+build.1',b'2.0.0'):
            with self.subTest(raw=raw),patch.object(m,'run_local',return_value=raw):
                self.assertTrue(self.run_check()['ok'])
    def test_collects_all_missing_build_tools_without_install(self):
        with patch.object(m.shutil,'which',side_effect=lambda name:'/trusted/bun' if name=='bun' else None):
            r=self.run_check('install');self.assertFalse(r['ok'])
            self.assertEqual(len([c for c in r['checks'] if c['id'].startswith('tool_') and c['status']=='fail']),len(m.BUILD_TOOLS))
    def test_build_header_probe_failure_does_not_echo_raw_error(self):
        def probe(args):
            if args[0].endswith('bun'):return b'1.3.13'
            raise OSError('DO_NOT_REPORT_SYNTHETIC_PRIVATE_VALUE')
        with patch.object(m,'run_local',side_effect=probe):
            r=self.run_check('install');self.assertFalse(r['ok']);self.assertNotIn('DO_NOT_REPORT',json.dumps(r))
    def test_home_and_parent_links_refused(self):
        alias=self.base/'alias';alias.symlink_to(self.home,target_is_directory=True)
        self.assertFalse(self.run_check(home=alias)['ok'])
        self.assertFalse(self.run_check('install',alias/'missing')['ok']);self.assertFalse((self.home/'missing').exists())
    def test_home_permissions_not_repaired(self):
        self.home.chmod(0o755);r=self.run_check();self.assertFalse(r['ok']);self.assertEqual(stat.S_IMODE(self.home.stat().st_mode),0o755)
    def test_private_ancestor_mode_refused(self):
        (self.home/'gbrain').chmod(0o755);r=self.run_check();self.assertEqual(self.item(r,'native_config')['code'],'owner_only_permissions_required')
    def test_relative_and_repository_overlapping_home_refused(self):
        for home in ('relative',self.repo,self.repo/'inside',self.base,self.home/'..'/'home'):
            with self.subTest(home=home),self.assertRaises(m.PreflightError):self.run_check(home=home)
    def test_linked_hardlinked_and_readable_secret_file_refused(self):
        path=self.home/'postgres/state.json';raw=path.read_bytes();path.unlink();path.symlink_to(self.home/'gbrain/.gbrain/config.json')
        self.assertFalse(self.run_check()['ok']);path.unlink()
        other=self.put('other',raw);os.link(other,path)
        self.assertEqual(self.item(self.run_check(),'database_state')['code'],'hardlink_refused')
        path.unlink();path.write_bytes(raw);path.chmod(0o644)
        self.assertEqual(self.item(self.run_check(),'database_state')['code'],'owner_only_permissions_required')
    def test_fifo_refused_without_blocking(self):
        path=self.home/'postgres/state.json';path.unlink();os.mkfifo(path,0o600)
        started=time.monotonic();r=self.run_check();self.assertFalse(r['ok']);self.assertLess(time.monotonic()-started,1)
    def test_json_errors_and_duplicate_keys_safe(self):
        for raw in (b'{"secret":"DO_NOT_REPORT",',b'[]',b'{"port":1,"port":2}',b'{"number":NaN}',b'\xff'):
            with self.subTest(raw=raw):
                self.put('postgres/state.json',raw);r=self.run_check();self.assertFalse(r['ok']);self.assertNotIn('DO_NOT_REPORT',json.dumps(r))
    def test_config_read_is_bounded_before_data_read(self):
        self.put('postgres/state.json',b' '*(m.MAX_CONFIG+1))
        r=self.run_check();self.assertEqual(self.item(r,'database_state')['code'],'config_too_large')
    def test_file_changed_during_read_is_rejected(self):
        target=self.home/'postgres/state.json';original=os.read;changed=False
        def read(fd,length):
            nonlocal changed
            raw=original(fd,length)
            if os.fstat(fd).st_ino==target.stat().st_ino and not changed:
                changed=True;target.write_bytes(b'{"changed":true}')
            return raw
        with patch.object(m.os,'read',side_effect=read):
            r=self.run_check();self.assertEqual(self.item(r,'database_state')['code'],'file_changed_during_check')
    def test_rename_home_detected(self):
        with m.PrivateHome(self.home) as view:
            self.home.rename(self.base/'original');self.home.mkdir(mode=0o700)
            with self.assertRaisesRegex(m.PreflightError,'home_changed'):view.unchanged()
    def test_database_url_is_checked_without_echoing_any_credentials(self):
        for raw in ('postgresql://ultrabrain:SECRET@example.invalid:6543/ultrabrain',
                    self.config['database_url']+'?sslmode=disable',self.config['database_url']+'#private',
                    self.config['database_url'].replace('/ultrabrain','/another',1),
                    self.config['database_url'].replace('6543','99999'),
                    self.config['database_url'].replace('ultrabrain:','postgres:'),
                    self.config['database_url'].replace('%25','%GG')):
            with self.subTest(raw=raw):
                self.put('gbrain/.gbrain/config.json',json.dumps({**self.config,'database_url':raw}).encode());r=self.run_check()
                self.assertFalse(r['ok']);self.assertEqual(self.item(r,'managed_database_config')['code'],'managed_database_mismatch')
                self.assertNotIn('SECRET',json.dumps(r));self.assertNotIn('example.invalid',json.dumps(r))
    def test_state_types_and_missing_password(self):
        for change in ({'port':'6543'},{'port':True},{'port':0},{'app_password':''},{'admin_password':[]},{'app_password':'x\0y'}):
            with self.subTest(change=change):
                self.put('postgres/state.json',json.dumps({**self.state,**change}).encode())
                self.assertEqual(self.item(self.run_check(),'database_state')['code'],'invalid_database_state')
    def test_all_accepted_managed_runtime_names(self):
        base='postgres-18.6-'+('b'*12);vector=base+'-pgvector-'+('c'*12)
        for directory in (base,vector,vector+'-portable-v1'):
            self.assertEqual(m.validate_binding({**self.binding,'directory':directory},self.pins['projects']),directory)
    def test_runtime_path_from_binding_cannot_escape(self):
        self.put('postgres/runtime.json',json.dumps({**self.binding,'directory':'../../PRIVATE_SECRET'}).encode())
        r=self.run_check();self.assertEqual(self.item(r,'runtime_binding')['code'],'invalid_runtime_directory')
        self.assertNotIn('PRIVATE_SECRET',json.dumps(r))
    def test_runtime_pins_marker_and_cluster_version_checked(self):
        self.put('postgres/runtime.json',json.dumps({**self.binding,'version':'18.7'}).encode())
        self.assertEqual(self.item(self.run_check(),'runtime_binding')['code'],'runtime_pin_mismatch')
        self.put('postgres/runtime.json',json.dumps(self.binding).encode())
        self.put('runtime/'+self.prefix+'/.ultrabrain-build',b'wrong')
        self.assertEqual(self.item(self.run_check(),'runtime_build_marker')['code'],'runtime_build_marker_mismatch')
        self.put('postgres/data/PG_VERSION',b'17')
        self.assertEqual(self.item(self.run_check(),'cluster_major')['code'],'cluster_major_mismatch')
    def test_missing_and_nonexecutable_runtime_binary(self):
        path=self.home/'runtime'/self.prefix/'bin/postgres';path.chmod(0o600)
        self.assertEqual(self.item(self.run_check(),'runtime_postgres')['code'],'runtime_binary_not_executable')
        path.unlink();self.assertEqual(self.item(self.run_check(),'runtime_postgres')['code'],'missing')
    def test_optional_credentials_metadata_only(self):
        self.put('service.env',b'UNPARSEABLE_SECRET');self.put('personal-console-token',b'ANOTHER_SECRET')
        original=m.PrivateHome.read
        def read(view,name,*a,**kw):
            self.assertNotIn(name,('service.env','personal-console-token'));return original(view,name,*a,**kw)
        with patch.object(m.PrivateHome,'read',read):
            r=self.run_check();self.assertTrue(r['ok']);self.assertNotIn('SECRET',json.dumps(r))
    def test_absent_optional_files_not_mislabelled_pass(self):
        r=self.run_check()
        self.assertEqual(self.item(r,'console_token')['status'],'not_checked')
        self.assertEqual(self.item(r,'service_environment')['status'],'not_checked')
    def test_legacy_configuration_never_migrated(self):
        native=self.home/'gbrain/.gbrain/config.json';raw=native.read_bytes();native.unlink();self.put('gbrain/config.json',raw)
        r=self.run_check();self.assertFalse(r['ok']);self.assertFalse(native.exists());self.assertEqual((self.home/'gbrain/config.json').read_bytes(),raw)
    def test_invalid_lock_does_not_dump_json(self):
        (self.repo/'upstreams.lock.json').write_text('{"TOKEN":"DO_NOT_REPORT"}')
        r=self.run_check();self.assertFalse(r['ok']);self.assertNotIn('DO_NOT_REPORT',json.dumps(r))
    def test_no_database_adapter_import_and_no_bun_requirement_for_direct_python(self):
        self.assertNotIn('ultrabrain_managed_pg',sys.modules)
        with patch.object(m.shutil,'which',return_value=None):
            self.assertEqual(self.item(self.run_check(),'bun')['code'],'bun_not_found')
    def test_cli_errors_do_not_echo_arguments(self):
        stream=io.StringIO()
        with contextlib.redirect_stdout(stream):
            code=m.main(['--mode','DO_NOT_REPORT_SYNTHETIC_PRIVATE_VALUE'])
        self.assertEqual(code,2);self.assertNotIn('DO_NOT_REPORT',stream.getvalue());self.assertEqual(json.loads(stream.getvalue())['error'],'invalid_arguments')
    def test_runtime_does_not_require_build_compilers(self):
        with patch.object(m.shutil,'which',side_effect=lambda name:'/trusted/bun' if name=='bun' else None):
            self.assertTrue(self.run_check()['ok']);self.assertFalse(any(c['id'].startswith('tool_') for c in self.run_check()['checks']))

class DependencyProbeTests(unittest.TestCase):
    def test_bounded_success_and_stderr(self):
        self.assertEqual(m.run_local([sys.executable,'-c','print("ok")']),b'ok\n')
        self.assertEqual(m.run_local([sys.executable,'-c','import sys;sys.stderr.write("ok")']),b'ok')
    def test_probe_does_not_inherit_credentials_or_runtime_options(self):
        names=('DATABASE_URL','GBRAIN_DATABASE_URL','OPENAI_API_KEY','NODE_OPTIONS','PYTHONPATH','BUN_OPTIONS','AWS_SECRET_ACCESS_KEY')
        with patch.dict(os.environ,{name:'SYNTHETIC_SECRET' for name in names}):
            raw=m.run_local([sys.executable,'-c','import os,json;print(json.dumps(sorted(os.environ)))'])
        got=json.loads(raw);self.assertFalse(set(names)&set(got));self.assertNotIn('HOME',got)
    def test_excess_stdout_or_stderr_is_refused(self):
        for target in ('stdout','stderr'):
            with self.subTest(target=target),self.assertRaisesRegex(m.PreflightError,'dependency_output_limit'):
                m.run_local([sys.executable,'-c',f'import sys;sys.{target}.write("x"*4097)'])
    def test_nonzero_output_not_reported(self):
        with self.assertRaisesRegex(m.PreflightError,'dependency_probe_failed') as e:
            m.run_local([sys.executable,'-c','print("PRIVATE_SECRET");raise SystemExit(1)'])
        self.assertNotIn('PRIVATE_SECRET',str(e.exception))
    def test_timeout_and_child_pipe_are_bounded(self):
        start=time.monotonic()
        with self.assertRaisesRegex(m.PreflightError,'dependency_probe_timeout'):
            m.run_local([sys.executable,'-c','import os,time; pid=os.fork();time.sleep(5) if pid==0 else None'],timeout=0.2)
        self.assertLess(time.monotonic()-start,2)
    def test_failure_before_spawn_not_raw_cli_output(self):
        with self.assertRaises(FileNotFoundError):m.run_local(['/missing/SYNTHETIC_SECRET'])
        output=io.StringIO()
        with contextlib.redirect_stdout(output),patch.object(m,'preflight',side_effect=FileNotFoundError('/missing/SYNTHETIC_SECRET')):
            self.assertEqual(m.main([]),2)
        self.assertNotIn('SYNTHETIC_SECRET',output.getvalue())

if __name__=='__main__':unittest.main()
