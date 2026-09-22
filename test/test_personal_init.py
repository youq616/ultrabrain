"""Offline bootstrap with synthetic files; real CLI, descriptor and crash boundaries."""
import contextlib
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ub_personal_init_test', ROOT/'scripts/personal-init.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class InitializationTests(unittest.TestCase):
    def setUp(self):
        self.mask = os.umask(0o077); self.addCleanup(os.umask, self.mask)
        self.tmp = tempfile.TemporaryDirectory(prefix='ub-init-test-'); self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name); self.home = self.base/'installation'; self.home.mkdir(mode=0o700)
        self.repo = self.base/'source'; self.repo.mkdir(mode=0o700)
        self.pins = json.loads((ROOT/'upstreams.lock.json').read_bytes())
        (self.repo/'upstreams.lock.json').write_text(json.dumps(self.pins))
        pins = self.pins['projects']; pg, vector = pins['postgres'], pins['pgvector']
        self.prefix = 'postgres-'+pg['version']+'-'+pg['revision'][:12]+'-pgvector-'+vector['revision'][:12]+'-portable-v1'
        self.state = {'port':6543,'admin_password':'SYNTHETIC_ADMIN_NEVER_PRINT', 'app_password':'SYNTHETIC_APP/SECRET%'}
        self.binding = {'version':pg['version'],'postgres_revision':pg['revision'],
                        'pgvector_revision':vector['revision'],'directory':self.prefix}
        self.config = {'engine':'postgres','database_url':'postgresql://ultrabrain:'+quote(self.state['app_password'],safe='')+'@127.0.0.1:6543/ultrabrain',
                       'provider_key':'SYNTHETIC_PROVIDER_NEVER_PRINT'}
        for name, value in {'postgres/state.json':self.state, 'postgres/runtime.json':self.binding,
                            'gbrain/.gbrain/config.json':self.config}.items():
            self.put(name, json.dumps(value).encode())
        self.put('postgres/data/PG_VERSION',pg['version'].split('.')[0].encode()+b'\n')
        self.put('runtime/'+self.prefix+'/.ultrabrain-build',(pg['revision']+':'+vector['revision']+'\n').encode())
        for binary in m.PREFLIGHT.RUNTIME_BINARIES:
            self.put('runtime/'+self.prefix+'/bin/'+binary,b'SYNTHETIC_NOT_EXECUTABLE_CODE').chmod(0o700)
        self.token = self.home/m.TOKEN

    def put(self, name, raw):
        p=self.home/name;p.parent.mkdir(parents=True,exist_ok=True,mode=0o700);p.write_bytes(raw);return p

    def run_init(self, action='create-token', home=None):
        return m.initialize(action, self.home if home is None else home, root=self.repo)

    def snapshot(self):
        return {p.relative_to(self.home).as_posix():(p.read_bytes(),p.stat().st_mtime_ns,stat.S_IMODE(p.stat().st_mode))
                for p in self.home.rglob('*') if p.is_file()}

    def cli(self, action, **kwargs):
        p=subprocess.run(['/usr/bin/python3','-I','-B',str(ROOT/'scripts/personal-init.py'),action,'--home',str(self.home)],
                         capture_output=True,text=True,timeout=10,**kwargs)
        self.assertEqual(p.stderr,'');return p.returncode,json.loads(p.stdout)

    def test_missing_status_reads_only_and_is_not_ready(self):
        before=self.snapshot();r=self.run_init('status')
        self.assertFalse(r['ok']);self.assertFalse(r['credential_ready']);self.assertEqual(r['token_creation'],'absent')
        self.assertEqual(before,self.snapshot());self.assertEqual(set(r)&{'token','token_sha256','instance_id'},set())

    def test_creates_only_fixed_owner_private_token_and_never_echoes_secrets(self):
        before=self.snapshot();r=self.run_init();raw=self.token.read_bytes()
        self.assertTrue(r['ok']);self.assertEqual(r['token_creation'],'created');self.assertRegex(raw,rb'^[a-f0-9]{64}\n$')
        self.assertEqual(stat.S_IMODE(self.token.stat().st_mode),0o600);self.assertEqual(self.token.stat().st_nlink,1)
        after=self.snapshot();after.pop(m.TOKEN);self.assertEqual(after,before)
        for secret in (raw.strip().decode(),self.state['app_password'],self.state['admin_password'],self.config['provider_key']):
            self.assertNotIn(secret,json.dumps(r))
        for k in (*m.NO_ACTIONS,'instance_identity_verified','token_value_returned'):self.assertFalse(r[k])

    def test_existing_token_is_reused_byte_exact_without_any_write_or_random_generation(self):
        self.put(m.TOKEN,b'c'*64+b'\n');before=self.snapshot()
        with patch.object(m.secrets,'token_hex',side_effect=AssertionError('must not generate')), \
             patch.object(m.os,'write',side_effect=AssertionError('must not write')), \
             patch.object(m.os,'fchmod',side_effect=AssertionError('must not chmod')):
            for action in ('status','create-token'):self.assertEqual(self.run_init(action)['token_creation'],'existing')
        self.assertEqual(self.snapshot(),before)

    def test_public_cli_missing_create_and_reuse_exit_contract(self):
        code,r=self.cli('status');self.assertEqual(code,1);self.assertEqual(r['token_creation'],'absent')
        code,r=self.cli('create-token');self.assertEqual(code,0);self.assertEqual(r['token_creation'],'created')
        before=self.snapshot();code,r=self.cli('create-token');self.assertEqual(code,0);self.assertEqual(r['token_creation'],'existing')
        self.assertEqual(self.snapshot(),before)

    def test_os_random_failure_precedes_path_creation(self):
        with patch.object(m.secrets,'token_hex',side_effect=OSError('SYNTHETIC_RANDOM_ERROR')):
            with self.assertRaises(OSError):self.run_init()
        self.assertFalse(self.token.exists())

    def test_new_token_mode_is_correct_even_with_overrestrictive_umask(self):
        old=os.umask(0o777)
        try:self.assertTrue(self.run_init()['ok'])
        finally:os.umask(old)
        self.assertEqual(stat.S_IMODE(self.token.stat().st_mode),0o600)

    def test_missing_home_or_missing_required_config_never_creates_anything(self):
        absent=self.base/'missing'/'nested'
        with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init(home=absent)
        self.assertFalse(absent.parent.exists())
        (self.home/'postgres/state.json').unlink()
        with self.assertRaises(FileNotFoundError):self.run_init()
        self.assertFalse(self.token.exists())

    def test_root_foreign_platform_and_uid_mismatch_refused_before_private_inspection(self):
        for field,value in [('getuid',0),('geteuid',0),('geteuid',os.getuid()+1)]:
            with self.subTest(field=field,value=value),patch.object(m.os,field,return_value=value), \
                 patch.object(m.PREFLIGHT,'PrivateHome',side_effect=AssertionError('must not inspect')):
                with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()
        with patch.object(m.sys,'platform','win32'),patch.object(m.PREFLIGHT,'PrivateHome',side_effect=AssertionError):
            with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()

    def test_relative_traversal_control_and_repository_overlap_are_refused(self):
        for home in ('relative',self.home/'..'/'installation',str(self.home)+'\n',self.repo,self.repo/'data',self.base):
            with self.subTest(home=str(home)),self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init(home=home)
        self.assertFalse(self.token.exists())

    def test_home_links_and_wide_permissions_are_never_repaired(self):
        alias=self.base/'alias';alias.symlink_to(self.home,target_is_directory=True)
        with self.assertRaises(OSError):self.run_init(home=alias)
        self.home.chmod(0o755)
        with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()
        self.assertEqual(stat.S_IMODE(self.home.stat().st_mode),0o755);self.assertFalse(self.token.exists())

    def test_malformed_duplicate_or_foreign_database_config_is_refused_without_mutation(self):
        config=self.home/'gbrain/.gbrain/config.json'
        for raw in (b'not-json',b'{"engine":"postgres","engine":"postgres"}',json.dumps({**self.config,'engine':'pglite'}).encode(),
                    json.dumps({**self.config,'database_url':self.config['database_url'].replace('127.0.0.1','remote.invalid')}).encode()):
            with self.subTest(raw=raw):
                config.write_bytes(raw);before=self.snapshot()
                with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()
                self.assertEqual(before,self.snapshot());self.assertFalse(self.token.exists())

    def test_bad_runtime_pin_marker_binary_or_cluster_major_prevents_token(self):
        paths={'postgres/runtime.json':json.dumps({**self.binding,'postgres_revision':'0'*40}).encode(),
               'runtime/'+self.prefix+'/.ultrabrain-build':b'wrong', 'postgres/data/PG_VERSION':b'0'}
        for name,raw in paths.items():
            p=self.home/name;original=p.read_bytes()
            try:
                p.write_bytes(raw)
                with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()
                self.assertFalse(self.token.exists())
            finally:p.write_bytes(original)
        (self.home/('runtime/'+self.prefix+'/bin/postgres')).chmod(0o600)
        with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()
        self.assertFalse(self.token.exists())

    def test_empty_malformed_oversized_and_nonascii_tokens_are_not_replaced(self):
        for raw in (b'',b'bad',b'a'*129,b'\xff'+b'a'*64,b'A'*64,b'0'*63):
            self.put(m.TOKEN,raw);before=self.snapshot()
            for action in ('status','create-token'):
                with self.subTest(raw=raw,action=action),self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init(action)
                self.assertEqual(before,self.snapshot())

    def test_symlink_and_hardlink_tokens_are_refused_and_preserved(self):
        outside=self.base/'outside';outside.write_bytes(b'd'*64)
        self.token.symlink_to(outside)
        with self.assertRaises(OSError):self.run_init()
        self.assertTrue(self.token.is_symlink());self.token.unlink();os.link(outside,self.token)
        with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()
        self.assertEqual(self.token.stat().st_nlink,2);self.assertEqual(outside.read_bytes(),b'd'*64)

    def test_fifo_directory_or_wide_token_is_refused_without_blocking_or_repair(self):
        os.mkfifo(self.token,0o600)
        for action in ('status','create-token'):
            code,r=self.cli(action);self.assertEqual(code,1);self.assertEqual(r['error'],'wrong_file_type')
        self.assertTrue(stat.S_ISFIFO(self.token.stat().st_mode));self.token.unlink();self.token.mkdir(mode=0o700)
        with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()
        self.token.rmdir();self.put(m.TOKEN,b'a'*64).chmod(0o644)
        with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()
        self.assertEqual(stat.S_IMODE(self.token.stat().st_mode),0o644)

    def test_missing_token_with_deployment_history_requires_recovery_not_new_secret(self):
        for name in ('personal-deployment','personal-activation'):
            p=self.home/name;p.mkdir(mode=0o700)
            with self.assertRaisesRegex(m.PREFLIGHT.PreflightError,'token_recovery_required'):self.run_init()
            self.assertFalse(self.token.exists());p.rmdir()
        # An existing valid token may still be inspected/reused after deployment.
        (self.home/'personal-deployment').mkdir(mode=0o700);self.put(m.TOKEN,b'e'*64)
        self.assertEqual(self.run_init()['token_creation'],'existing')

    def test_linked_or_corrupt_deployment_history_is_not_treated_as_absent(self):
        p=self.home/'personal-deployment';p.symlink_to(self.base/'missing')
        with self.assertRaisesRegex(m.PREFLIGHT.PreflightError,'token_recovery_required'):self.run_init()
        self.assertTrue(p.is_symlink());self.assertFalse(self.token.exists())

    def test_short_writes_are_completed_and_file_then_directory_are_synced(self):
        write=m.os.write;fsync=m.os.fsync;syncs=[]
        def short(fd,data):return write(fd,data[:7])
        def sync(fd):syncs.append(stat.S_ISDIR(os.fstat(fd).st_mode));return fsync(fd)
        with patch.object(m.os,'write',side_effect=short),patch.object(m.os,'fsync',side_effect=sync):self.run_init()
        self.assertEqual(syncs,[False,True]);self.assertEqual(len(self.token.read_bytes()),65)

    def test_zero_write_is_rejected_and_empty_file_is_retained(self):
        with patch.object(m.os,'write',return_value=0):
            with self.assertRaisesRegex(m.PREFLIGHT.PreflightError,'token_write_incomplete'):self.run_init()
        self.assertEqual(self.token.read_bytes(),b'')
        with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()

    def test_disk_full_retains_partial_file_and_retry_does_not_rotate(self):
        original=m.os.write;count=0
        def partial(fd,raw):
            nonlocal count
            count+=1
            if count==1:return original(fd,raw[:9])
            raise OSError(errno.ENOSPC,'SYNTHETIC_SECRET_ERROR')
        with patch.object(m.os,'write',side_effect=partial):
            with self.assertRaises(OSError):self.run_init()
        raw=self.token.read_bytes();self.assertEqual(len(raw),9)
        with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()
        self.assertEqual(self.token.read_bytes(),raw)

    def test_fsync_failure_is_not_success_and_preserves_complete_file_for_inspection(self):
        for directory in (False,True):
            if self.token.exists():self.token.unlink()
            real=m.os.fsync
            def fail(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode)==directory:raise OSError(errno.EIO,'SYNTHETIC_SECRET_ERROR')
                return real(fd)
            with patch.object(m.os,'fsync',side_effect=fail):
                with self.assertRaises(OSError):self.run_init()
            self.assertRegex(self.token.read_bytes(),rb'^[a-f0-9]{64}\n$')
            # Read-only status observes current readable bytes; it is not a past fsync attestation.
            self.assertEqual(self.run_init('status')['token_creation'],'existing')

    def test_path_swap_after_create_is_not_accepted_or_written_via_new_home(self):
        original=m.os.write;moved=self.base/'moved';triggered=False
        def swap(fd,raw):
            nonlocal triggered
            if not triggered:
                triggered=True;self.home.rename(moved);self.home.mkdir(mode=0o700)
            return original(fd,raw)
        with patch.object(m.os,'write',side_effect=swap):
            with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()
        self.assertFalse(self.token.exists());self.assertTrue((moved/m.TOKEN).exists())

    def test_existing_token_replacement_after_read_is_detected(self):
        self.put(m.TOKEN,b'f'*64);original=m.PREFLIGHT.check_pins;calls=0
        def changed(root):
            nonlocal calls
            calls+=1
            if calls==2:
                self.token.unlink();self.put(m.TOKEN,b'b'*64)
            return original(root)
        with patch.object(m.PREFLIGHT,'check_pins',side_effect=changed):
            with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init('status')

    def test_config_changes_during_creation_are_detected(self):
        original=m.os.write
        def changed(fd,raw):
            p=self.home/'gbrain/.gbrain/config.json';p.write_text(json.dumps({**self.config,'note':'changed'}))
            return original(fd,raw)
        with patch.object(m.os,'write',side_effect=changed):
            with self.assertRaises(m.PREFLIGHT.PreflightError):self.run_init()

    def test_foreign_creator_wins_without_second_write_or_overwrite(self):
        real=m.os.open
        def race(path,flags,*args,**kwargs):
            if path==m.TOKEN and flags & os.O_CREAT:self.put(m.TOKEN,b'd'*64+b'\n')
            return real(path,flags,*args,**kwargs)
        with patch.object(m.os,'open',side_effect=race):self.assertEqual(self.run_init()['token_creation'],'existing')
        self.assertEqual(self.token.read_bytes(),b'd'*64+b'\n')

    def test_initializer_flock_contention_never_creates_token_or_lock_file(self):
        import fcntl
        fd=os.open(self.home,os.O_RDONLY|os.O_DIRECTORY)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            before=self.snapshot();code,r=self.cli('create-token')
            self.assertEqual(code,1);self.assertEqual(r['error'],'initialization_busy');self.assertEqual(before,self.snapshot())
        finally:os.close(fd)

    def test_concurrent_cli_creation_keeps_one_token_and_refusals_are_explicit(self):
        args=['/usr/bin/python3','-I','-B',str(ROOT/'scripts/personal-init.py'),'create-token','--home',str(self.home)]
        children=[subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE) for _ in range(8)]
        results=[]
        try:
            for child in children:
                out,err=child.communicate(timeout=10);self.assertEqual(err,b'');results.append(json.loads(out))
        finally:
            for child in children:
                if child.poll() is None:child.kill();child.wait()
        self.assertEqual(sum(r['token_creation']=='created' for r in results),1)
        self.assertTrue(all(r['ok'] or r['error']=='initialization_busy' for r in results))
        raw=self.token.read_bytes();self.assertTrue(self.run_init()['ok']);self.assertEqual(self.token.read_bytes(),raw)

    def test_actual_process_death_leaves_incomplete_token_and_releases_directory_lock(self):
        code="""import importlib.util, os, sys
s=importlib.util.spec_from_file_location('init',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def die(fd,raw):os._exit(91)
m.os.write=die
m.initialize('create-token',sys.argv[2])
"""
        r=subprocess.run(['/usr/bin/python3','-I','-B','-c',code,str(ROOT/'scripts/personal-init.py'),str(self.home)],capture_output=True,timeout=10)
        self.assertEqual(r.returncode,91);self.assertEqual(r.stdout,b'');self.assertEqual(self.token.read_bytes(),b'')
        rc,value=self.cli('create-token');self.assertEqual(rc,1);self.assertEqual(value['error'],'invalid_console_token')
        self.assertEqual(self.token.read_bytes(),b'')

    def test_error_envelope_never_claims_no_write_or_prints_raw_exception(self):
        output=io.StringIO()
        with patch.object(m,'initialize',side_effect=OSError(errno.EIO,'SYNTHETIC_SECRET_ERROR')),contextlib.redirect_stdout(output):
            self.assertEqual(m.main(['create-token','--home',str(self.home)]),1)
        value=json.loads(output.getvalue());self.assertEqual(value['token_creation'],'not_proven')
        self.assertNotIn('SYNTHETIC',output.getvalue());self.assertNotIn('changes_made',value)

    def test_valid_but_substituted_token_bytes_cannot_be_reported_as_our_creation(self):
        sync=m.os.fsync;changed=False
        def replace_during_sync(fd):
            nonlocal changed
            sync(fd)
            if not changed and stat.S_ISREG(os.fstat(fd).st_mode):
                changed=True;self.token.write_bytes(b'b'*64+b'\n')
        with patch.object(m.secrets,'token_hex',return_value='a'*64),patch.object(m.os,'fsync',side_effect=replace_during_sync):
            with self.assertRaisesRegex(m.PREFLIGHT.PreflightError,'token_changed_during_init'):self.run_init()
        self.assertEqual(self.token.read_bytes(),b'b'*64+b'\n')

    def test_init_does_not_probe_dependencies_or_open_network_connections(self):
        import socket
        with patch.object(m.PREFLIGHT,'run_local',side_effect=AssertionError('no dependency process')), \
             patch.object(subprocess,'Popen',side_effect=AssertionError('no subprocess')), \
             patch.object(socket,'socket',side_effect=AssertionError('no network')):
            self.assertTrue(self.run_init()['ok'])


if __name__=='__main__':unittest.main()
