"""Synthetic process binding and actual bounded child pipes; no real database here."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
from urllib.parse import quote
from test_personal_ready_process import ProcessFixture

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('personal_identity_test', ROOT/'scripts/personal-identity.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
INSTANCE = '11111111-1111-4111-8111-111111111111'

def row(**changes):
    return {'format': 1, 'source_id': 'default', 'source_exists': True, 'instance_id': INSTANCE,
            'backend_pid': 424245, 'database_port': 6543, 'database_name': 'ultrabrain',
            'database_user': 'ultrabrain', 'database_session_user': 'ultrabrain',
            'unix_socket': True, 'read_only': True, 'schema_ready': True, **changes}


class IdentityTests(ProcessFixture):
    def setUp(self):
        super().setUp()
        self.home = self.base/'home'; self.home.mkdir(mode=0o700)
        pins_file = json.loads((ROOT/'upstreams.lock.json').read_bytes())
        self.pins = pins_file['projects']
        self.write(self.root/'upstreams.lock.json', json.dumps(pins_file).encode())
        pg, vector = self.pins['postgres'], self.pins['pgvector']
        self.prefix = f"postgres-{pg['version']}-{pg['revision'][:12]}-pgvector-{vector['revision'][:12]}-portable-v1"
        prefix = self.home/'runtime'/self.prefix
        self.pg = self.write(prefix/'bin/postgres', b'SYNTHETIC_NOT_RUN'); self.pg.chmod(0o700)
        self.psql = self.write(prefix/'bin/psql', b'SYNTHETIC_NOT_RUN'); self.psql.chmod(0o700)
        (prefix/'lib').mkdir(mode=0o700)
        self.write(prefix/'.ultrabrain-build', (pg['revision']+':'+vector['revision']).encode())
        self.state = {'port':6543,'app_password':'SYNTHETIC_APP_PRIVATE','admin_password':'SYNTHETIC_ADMIN_PRIVATE'}
        self.binding = {'version':pg['version'],'postgres_revision':pg['revision'],
                        'pgvector_revision':vector['revision'],'directory':self.prefix}
        self.config = {'engine':'postgres','database_url':'postgresql://ultrabrain:'+quote(self.state['app_password'],safe='')+'@127.0.0.1:6543/ultrabrain'}
        for name,value in [('postgres/state.json',self.state),('postgres/runtime.json',self.binding),('gbrain/.gbrain/config.json',self.config)]:
            self.write(self.home/name,json.dumps(value).encode())
        self.data = self.home/'postgres/data'
        self.write(self.data/'PG_VERSION',pg['version'].split('.')[0].encode())
        self.postmaster_pid, self.backend_pid = 424244, 424245
        self.write(self.data/'postmaster.pid', ('\n'.join([str(self.postmaster_pid),str(self.data),'1789731000','6543',
                   str(self.home/'postgres/socket'),'127.0.0.1','54321 98765','ready   '])+'\n').encode())
        self.process(self.postmaster_pid,self.pg,cwd=self.data)
        self.process(self.backend_pid,self.pg,ppid=self.postmaster_pid,start=123457,cwd=self.data)
        sockdir = self.home/'postgres/socket'; sockdir.mkdir(mode=0o700)
        self.sockpath = sockdir/'.s.PGSQL.6543'
        self.socket = socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); self.socket.bind(str(self.sockpath))
        self.addCleanup(self.socket.close)
        p = patch.object(m.PROCESS,'PROC_ROOT',self.proc); p.start(); self.addCleanup(p.stop)
        self.events=[]; self.response=row(); self.on_line=lambda:None; self.on_finish=lambda:None
        owner=self
        class Session(contextlib.AbstractContextManager):
            def __init__(self,*args): owner.events.append('connect')
            def send(self,data): owner.events.append('query'); owner.assertEqual(data,m.SQL)
            def line(self): owner.on_line(); return json.dumps(owner.response).encode()
            def finish(self): owner.events.append('rollback'); owner.on_finish()
            def __exit__(self,*_): owner.events.append('close')
        p=patch.object(m,'PsqlSession',Session);p.start();self.addCleanup(p.stop)

    def observe(self): return m.observe(self.home,root=self.root)
    def snapshot(self):
        return {p.relative_to(self.home).as_posix():(p.read_bytes(),p.stat().st_ino,p.stat().st_mtime_ns,p.stat().st_mode)
                for p in self.home.rglob('*') if p.is_file()}

    def test_success_binds_live_backend_and_returns_no_secrets_or_readiness(self):
        before=self.snapshot(); result=self.observe()
        self.assertEqual(result['instance_id'],INSTANCE);self.assertTrue(result['identity_verified'])
        self.assertTrue(result['database_process_binding_verified']);self.assertEqual(self.snapshot(),before)
        self.assertEqual(self.events,['connect','query','rollback','close'])
        for key in m.NO_ACTIONS:self.assertFalse(result[key])
        for text in [self.state['app_password'],self.state['admin_password'],str(self.home),'token']:
            self.assertNotIn(text,json.dumps(result))

    def test_missing_installation_never_connects_or_creates_files(self):
        missing=self.base/'absent'
        with self.assertRaises(Exception):m.observe(missing,root=self.root)
        self.assertFalse(missing.exists());self.assertEqual(self.events,[])

    def test_root_uid_mismatch_or_foreign_platform_refuses_before_inspection(self):
        for name,value in [('getuid',0),('geteuid',0),('geteuid',os.getuid()+1)]:
            with self.subTest(name=name,value=value),patch.object(m.os,name,return_value=value),patch.object(m.PREFLIGHT,'PrivateHome',side_effect=AssertionError):
                with self.assertRaises(m.IdentityError):self.observe()
        with patch.object(m.sys,'platform','win32'),self.assertRaises(m.IdentityError):self.observe()
        self.assertEqual(self.events,[])

    def test_unsafe_source_and_secondary_path_separators_refused_before_connect(self):
        for source in ['OTHER','../bad',"a'; SELECT 1;--",'a,b','a\n','a'*33]:
            with self.subTest(source=source),self.assertRaises(m.IdentityError):m.observe(self.home,source,root=self.root)
        for home in [str(self.home)+',remote',str(self.home)+':other','relative','/tmp/../x',str(self.home)+'\n']:
            with self.subTest(home=home),self.assertRaises(Exception):m.observe(home,root=self.root)
        self.assertEqual(self.events,[])

    def test_runtime_binding_or_remote_config_refused_before_connect(self):
        config=self.home/'gbrain/.gbrain/config.json'; original=config.read_bytes()
        config.write_bytes(original.replace(b'127.0.0.1',b'foreign.invalid'))
        with self.assertRaises(Exception):self.observe()
        self.assertEqual(self.events,[])

    def test_unready_or_missing_postmaster_never_starts_database(self):
        pidfile=self.data/'postmaster.pid';original=pidfile.read_bytes()
        for raw in [original.replace(b'ready   ',b'stopping'),original.replace(b'424244',b'999999')]:
            pidfile.write_bytes(raw)
            with self.assertRaises(Exception):self.observe()
        self.assertEqual(self.events,[])

    def test_socket_symlink_or_regular_file_is_refused(self):
        self.sockpath.unlink();self.sockpath.symlink_to(self.home/'postgres/state.json')
        with self.assertRaises(m.IdentityError):self.observe()
        self.sockpath.unlink();self.sockpath.write_bytes(b'not a socket')
        with self.assertRaises(m.IdentityError):self.observe()
        self.assertEqual(self.events,[])

    def test_psql_symlink_or_wide_permissions_refused_before_connect(self):
        self.psql.chmod(0o722)
        with self.assertRaises(m.IdentityError):self.observe()
        self.psql.unlink();self.psql.symlink_to(self.pg)
        with self.assertRaises(m.IdentityError):self.observe()
        self.assertEqual(self.events,[])

    def test_foreign_backend_parent_cannot_certify_identity(self):
        self.write(self.proc/str(self.backend_pid)/'stat',self.process_stat(self.backend_pid,ppid=222,start=123457))
        self.write(self.proc/str(self.backend_pid)/'status',f'Pid:\t{self.backend_pid}\nTgid:\t{self.backend_pid}\nPPid:\t222\nUid:\t{self.uid}\t{self.uid}\t{self.uid}\t{self.uid}\n'.encode())
        with self.assertRaises(m.IdentityError):self.observe()
        self.assertEqual(self.events,['connect','query','close'])

    def test_replaced_config_socket_or_postmaster_is_detected_during_query(self):
        for target in [self.home/'gbrain/.gbrain/config.json',self.data/'postmaster.pid']:
            original=target.read_bytes()
            def change():target.write_bytes(original+b' ')
            self.on_line=change
            with self.subTest(target=target.name),self.assertRaises(Exception):self.observe()
            target.write_bytes(original)
        self.on_line=lambda:self.sockpath.unlink()
        with self.assertRaises(Exception):self.observe()

    def test_postmaster_changed_during_rollback_is_not_reported_as_success(self):
        self.on_finish=lambda:self.write(self.data/'postmaster.pid',b'not valid')
        with self.assertRaises(Exception):self.observe()
        self.assertEqual(self.events,['connect','query','rollback','close'])

    def test_replaced_psql_or_pin_is_detected_after_query(self):
        self.on_line=lambda:self.psql.write_bytes(b'REPLACED')
        with self.assertRaises(Exception):self.observe()
        self.psql.write_bytes(b'SYNTHETIC_NOT_RUN')
        self.on_line=lambda:self.write(self.root/'upstreams.lock.json',b'{}')
        with self.assertRaises(Exception):self.observe()

    def test_wrong_json_bindings_or_missing_source_prevent_backend_acceptance(self):
        for change in [{'source_exists':False},{'source_id':'foreign'},{'schema_ready':False},{'read_only':False},
                       {'unix_socket':False},{'database_port':True},{'database_port':6544},
                       {'database_user':'ultrabrain_admin'},{'database_session_user':'other'},
                       {'backend_pid':True},{'instance_id':None},{'instance_id':'00000000-0000-0000-0000-000000000000'}]:
            self.response=row(**change)
            with self.subTest(change=change),self.assertRaises(m.IdentityError):self.observe()


class ContractTests(unittest.TestCase):
    def test_response_requires_exact_keys_and_canonical_field_types(self):
        self.assertEqual(m.validate_row(json.dumps(row()).encode(),'default',6543),row())
        for value in [[],{},row(extra='unsafe'),row(format=True),row(format=2),row(instance_id='invalid')]:
            with self.subTest(value=value),self.assertRaises(Exception):m.validate_row(json.dumps(value).encode(),'default',6543)
        for raw in [b'{"format":1,"format":1}',b'{"value":NaN}',b'{}\n{}',b'\xff',b'x'*4097]:
            with self.assertRaises(Exception):m.validate_row(raw,'default',6543)

    def test_invocation_uses_private_socket_peer_scram_and_fixed_environment(self):
        database={'runtime_directory':'postgres-fixture','port':6543}
        with patch.dict(os.environ,{'PGHOST':'foreign','PGHOSTADDR':'1.2.3.4','PGSERVICE':'evil','LD_PRELOAD':'evil','OPENAI_API_KEY':'PRIVATE'},clear=False):
            command,env=m.invocation(Path('/tmp/identity'),database,'default','PASSWORD_PRIVATE')
        self.assertNotIn('PASSWORD_PRIVATE',str(command));self.assertNotIn('PRIVATE',str(command))
        for flag in ['-X','-w','-q','ON_ERROR_STOP=1','source=default']:self.assertIn(flag,command)
        self.assertIn("host='/tmp/identity/postgres/socket'",command[-1])
        self.assertIn("require_auth='scram-sha-256'",command[-1]);self.assertIn('requirepeer=',command[-1])
        self.assertEqual(set(env),{'PATH','LC_ALL','PGPASSWORD','PGPASSFILE','LD_LIBRARY_PATH','PGOPTIONS'})
        self.assertEqual(env['PGPASSWORD'],'PASSWORD_PRIVATE');self.assertEqual(env['PGPASSFILE'],'/dev/null')
        self.assertIn('default_transaction_read_only=on',env['PGOPTIONS'])

    def test_loader_tokens_and_semicolon_paths_cannot_select_other_libraries(self):
        for home in ['/tmp/private;other','/tmp/$ORIGIN/private','/tmp/${LIB}/private']:
            with self.subTest(home=home),self.assertRaises(m.IdentityError):m.selection(home,'default')

    def test_socket_owned_by_another_account_is_refused(self):
        from types import SimpleNamespace
        st=SimpleNamespace(st_mode=stat.S_IFSOCK,st_uid=os.geteuid()+1,st_nlink=1)
        with patch.object(m.os,'stat',return_value=st),self.assertRaises(m.IdentityError):m.socket_snapshot(1,6543)

    def test_long_socket_path_refused_before_child_creation(self):
        with self.assertRaises(m.IdentityError):m.invocation(Path('/tmp/'+'a'*100),{'runtime_directory':'pg','port':6543},'default','SECRET')

    def test_conninfo_quote_handles_quotes_and_backslashes_not_shell(self):
        self.assertEqual(m.conninfo_value("a'b\\c"),"'a\\'b\\\\c'")

    def test_no_arbitrary_sql_or_model_commands(self):
        self.assertTrue(m.SQL.startswith(b'BEGIN READ ONLY;'))
        self.assertEqual(m.SQL.count(b"WHERE id=:'source'"),1)
        self.assertNotIn(b'UPDATE ',m.SQL);self.assertNotIn(b'INSERT ',m.SQL);self.assertNotIn(b'\x00',m.SQL)
        self.assertLessEqual(len(m.SQL),4096);self.assertIn(b'ROLLBACK;',m.END)

    def test_cli_unknown_duplicate_missing_or_secret_options_are_sanitized(self):
        for args in [['--url','SECRET'],['--home'],['status'],['--source','a','--source','b'],['--home=/tmp/SECRET'],['--password','SECRET']]:
            out=io.StringIO()
            with contextlib.redirect_stdout(out),patch.object(m,'observe',side_effect=AssertionError):self.assertEqual(m.main(args),1)
            value=json.loads(out.getvalue());self.assertEqual(value['error'],'invalid_arguments');self.assertNotIn('SECRET',out.getvalue())

    def test_explicit_home_never_evaluates_default_and_errors_never_echo(self):
        for args,env in [(['--home','/tmp/explicit'],{}),([] ,{'ULTRABRAIN_HOME':'/tmp/environment'})]:
            with patch.dict(os.environ,env,clear=True),patch.object(m.Path,'home',side_effect=AssertionError), \
                 patch.object(m,'observe',side_effect=RuntimeError('PASSWORD_PRIVATE')) as observe,contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(m.main(args),1)
                observe.assert_called_once();self.assertNotIn('PASSWORD_PRIVATE',out.getvalue())


class PipeTests(unittest.TestCase):
    def session(self,script,seconds=2):
        return m.PsqlSession([sys.executable,'-I','-B','-c',script],{},time.monotonic()+seconds)

    def test_live_child_remains_open_through_row_then_rolls_back_and_is_reaped(self):
        script="import sys; sys.stdin.readline(); print('proof',flush=True); line=sys.stdin.readline(); print('ULTRABRAIN_IDENTITY_ROLLED_BACK',flush=True)"
        with self.session(script) as client:
            client.send(b'query\n');self.assertEqual(client.line(),b'proof');self.assertIsNone(client.child.poll())
            client.finish();self.assertEqual(client.child.returncode,0)
        self.assertTrue(client.child.stdout.closed)

    def test_oversized_stdout_or_stderr_is_bounded_and_child_reaped(self):
        for fd in [1,2]:
            with self.subTest(fd=fd),self.assertRaises(m.IdentityError):
                with self.session(f'import os,time; os.write({fd},b"x"*9000);time.sleep(10)') as client:
                    client.line()
            self.assertIsNotNone(client.child.returncode)

    def test_hung_or_drip_child_has_overall_deadline(self):
        for script in ['import time;time.sleep(10)','import os,time\nwhile True: os.write(1,b"x");time.sleep(.03)']:
            start=time.monotonic()
            with self.assertRaises(m.IdentityError):
                with self.session(script,.2) as client:client.line()
            self.assertLess(time.monotonic()-start,3);self.assertIsNotNone(client.child.returncode)

    def test_nonzero_exit_after_ack_is_still_failure(self):
        script="import sys;sys.stdin.readline();print('ULTRABRAIN_IDENTITY_ROLLED_BACK',flush=True);sys.exit(3)"
        with self.assertRaises(m.IdentityError):
            with self.session(script) as client:client.finish()
        self.assertEqual(client.child.returncode,3)

    def test_extra_rows_and_invalid_ack_are_rejected(self):
        for output in ['other','ULTRABRAIN_IDENTITY_ROLLED_BACK\\nextra']:
            script=f'import sys;sys.stdin.readline();print("{output}",flush=True)'
            with self.assertRaises(m.IdentityError):
                with self.session(script) as client:client.finish()

    def test_early_eof_fails_instead_of_certifying_empty_identity(self):
        with self.assertRaises(m.IdentityError):
            with self.session('pass') as client:client.line()

    def test_already_expired_deadline_never_spawns(self):
        with patch.object(m.subprocess,'Popen',side_effect=AssertionError),self.assertRaises(m.IdentityError):
            m.PsqlSession([],{},time.monotonic()-1)

    def test_selector_failure_never_starts_child(self):
        with patch.object(m.selectors,'DefaultSelector',side_effect=OSError),patch.object(m.subprocess,'Popen') as spawn:
            with self.assertRaises(OSError):m.PsqlSession([],{},time.monotonic()+2)
            spawn.assert_not_called()

    def test_spawn_failure_closes_selector(self):
        selector=m.selectors.DefaultSelector()
        with patch.object(m.selectors,'DefaultSelector',return_value=selector),patch.object(m.subprocess,'Popen',side_effect=OSError):
            with self.assertRaises(OSError):m.PsqlSession([],{},time.monotonic()+2)
        self.assertIsNone(selector.get_map())

    def test_zero_write_is_failure_and_child_is_reaped(self):
        with self.assertRaises(m.IdentityError):
            with self.session('import time;time.sleep(10)') as client,patch.object(m.os,'write',return_value=0):client.send(b'x')
        self.assertIsNotNone(client.child.returncode)

    def test_send_handles_short_writes(self):
        script="import sys;print(sys.stdin.readline().strip(),flush=True)"
        actual=m.os.write
        with self.session(script) as client,patch.object(m.os,'write',side_effect=lambda fd,raw:actual(fd,raw[:1])):
            client.send(b'bounded\n');self.assertEqual(client.line(),b'bounded')


if __name__ == '__main__':unittest.main()
