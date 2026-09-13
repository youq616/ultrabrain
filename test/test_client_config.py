import importlib.util
import json
import os
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch as mock
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('client_config',ROOT/'scripts/client-config.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ClientConfigTests(unittest.TestCase):
    def setUp(self):
        old_umask=os.umask(0o077);self.addCleanup(os.umask,old_umask)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.path=Path(self.temp.name)/'settings.json'
        self.cmd=['node',str(Path(self.temp.name)/'client cli.cjs'),'mcp','--profile',str(Path(self.temp.name)/'profile.json')]
    def test_all_json_client_shapes_preserve_unrelated_credentials(self):
        for client in ['claude-code','opencode','zcode']:
            old=b'{"existing_secret":"PRIVATE","custom":[1]}'
            out=m.patch(client,old,self.cmd);parsed=json.loads(out)
            self.assertEqual(parsed['existing_secret'],'PRIVATE');self.assertEqual(parsed['custom'],[1])
            self.assertEqual(m.patch(client,out,self.cmd),out)
    def test_codex_toml_preserves_comments_and_content(self):
        old=b'# custom comment\nmodel = "existing"\n[mcp_servers.other]\ncommand = "existing"\n'
        out=m.patch('codex',old,self.cmd);self.assertTrue(out.startswith(old));self.assertEqual(tomllib.loads(out.decode())['mcp_servers']['ultrabrain']['command'],'node')
        self.assertEqual(m.patch('codex',out,self.cmd),out)
    def test_different_existing_server_refused(self):
        for client,old in [('codex',b'[mcp_servers.ultrabrain]\ncommand="other"'),('claude-code',b'{"mcpServers":{"ultrabrain":{}}}'),('opencode',b'{"mcp":{"ultrabrain":{}}}')]:
            with self.assertRaises(m.ConfigError):m.patch(client,old,self.cmd)
    def test_duplicate_json_keys_not_silently_discarded(self):
        with self.assertRaises(m.ConfigError):m.patch('claude-code',b'{"hooks":1,"hooks":2}',self.cmd)
    def test_jsonc_refused_without_rewriting_comments(self):
        with self.assertRaises(Exception):m.patch('opencode',b'{// comment\n}',self.cmd)
    def test_hooks_merged_once_without_affecting_permissions(self):
        old=b'{"permissions":{"allow":["Read"]},"hooks":{"SessionStart":[{"matcher":"resume","hooks":[]}]}}'
        out=m.patch('claude-hooks',old,self.cmd);p=json.loads(out);self.assertEqual(len(p['hooks']['SessionStart']),2);self.assertEqual(p['permissions'],{'allow':['Read']})
        self.assertEqual(m.patch('claude-hooks',out,self.cmd),out)
    def test_hooks_shell_quotes_metacharacters(self):
        command=self.cmd.copy();command[1]=str(Path(self.temp.name)/"x'$(touch evil).cjs")
        out=json.loads(m.patch('claude-hooks',None,command));cmd=out['hooks']['SessionStart'][0]['hooks'][0]['command']
        import shlex
        self.assertEqual(shlex.split(cmd)[1],command[1].replace('\\','/'))
    def test_apply_backup_rollback_exact_bytes(self):
        old=b'{ "unchanged": true }\r\n';self.path.write_bytes(old);new=m.patch('claude-code',old,self.cmd)
        r=m.apply(self.path,old,new,m.digest(old));self.assertEqual(self.path.read_bytes(),new)
        m.rollback(self.path,r['rollback_receipt']);self.assertEqual(self.path.read_bytes(),old)
    def test_new_config_rollback_removes_only_our_file(self):
        new=m.patch('claude-code',None,self.cmd);r=m.apply(self.path,None,new,'absent');m.rollback(self.path,r['rollback_receipt']);self.assertFalse(self.path.exists())
    def test_rollback_refuses_later_user_edits(self):
        new=m.patch('claude-code',None,self.cmd);r=m.apply(self.path,None,new,'absent');self.path.write_bytes(b'USER CHANGE')
        with self.assertRaises(m.ConfigError):m.rollback(self.path,r['rollback_receipt'])
        self.assertEqual(self.path.read_bytes(),b'USER CHANGE')
    def test_apply_refuses_stale_expected_sha(self):
        self.path.write_bytes(b'{}')
        with self.assertRaises(m.ConfigError):m.apply(self.path,b'{}',b'{"x":1}','absent')
        self.assertEqual(self.path.read_bytes(),b'{}')
    def test_apply_refuses_changed_file_between_plan_and_write(self):
        self.path.write_bytes(b'{"changed":true}')
        with self.assertRaises(m.ConfigError):m.apply(self.path,b'{}',b'{"x":1}',m.digest(b'{}'))
        self.assertEqual(self.path.read_bytes(),b'{"changed":true}')
    def test_rollback_evidence_exists_before_replace(self):
        with mock.object(m,'replace_config',side_effect=RuntimeError('simulated crash')):
            with self.assertRaises(RuntimeError):m.apply(self.path,None,b'{}','absent')
        self.assertEqual(len(list(self.path.parent.glob('*.receipt.json'))),1);self.assertFalse(self.path.exists())
    def test_symlink_target_refused(self):
        other=self.path.with_name('other');other.write_bytes(b'{}')
        try:self.path.symlink_to(other)
        except OSError:self.skipTest('Symlink creation not permitted by this Windows account')
        with self.assertRaises(m.ConfigError):m.read_file(self.path)
    def test_command_requires_absolute_paths_and_no_control_characters(self):
        with self.assertRaises(m.ConfigError):m.command_spec('node','relative','relative')
        with self.assertRaises(m.ConfigError):m.command_spec('node\nBAD',self.cmd[1],self.cmd[-1])

    def test_actual_cli_plan_apply_and_rollback_emit_no_existing_secrets(self):
        import io
        from contextlib import redirect_stdout
        cli=Path(self.cmd[1]);cli.write_text('// fixture',encoding='utf8')
        profile=Path(self.cmd[-1]);profile.write_text('{"format":1}',encoding='utf8')
        old=b'{"secret":"DO_NOT_PRINT"}';self.path.write_bytes(old)
        args=['--client','claude-code','--target',str(self.path),'--cli',str(cli),'--profile',str(profile)]
        out=io.StringIO()
        with redirect_stdout(out):self.assertEqual(m.main(args),0)
        self.assertEqual(self.path.read_bytes(),old);self.assertNotIn('DO_NOT_PRINT',out.getvalue())
        out=io.StringIO()
        with redirect_stdout(out):self.assertEqual(m.main(args+['--apply','--expected-sha',m.digest(old)]),0)
        receipt=json.loads(out.getvalue())['rollback_receipt'];self.assertNotIn('DO_NOT_PRINT',out.getvalue())
        with redirect_stdout(io.StringIO()):self.assertEqual(m.main(['--target',str(self.path),'--rollback',receipt]),0)
        self.assertEqual(self.path.read_bytes(),old)
    def test_foreign_lock_is_not_deleted_when_apply_refuses(self):
        import io
        from contextlib import redirect_stdout
        cli=Path(self.cmd[1]);cli.write_text('// fixture',encoding='utf8')
        profile=Path(self.cmd[-1]);profile.write_text('{"format":1}',encoding='utf8')
        lock=self.path.with_name(self.path.name+'.ultrabrain-config.lock');lock.write_bytes(b'other writer')
        with redirect_stdout(io.StringIO()):self.assertEqual(m.main(['--client','claude-code','--target',str(self.path),'--cli',str(cli),'--profile',str(profile),'--apply','--expected-sha','absent']),1)
        self.assertEqual(lock.read_bytes(),b'other writer');self.assertFalse(self.path.exists())

class ClientProfileTests(unittest.TestCase):
    def test_source_contract_matches_server(self):
        from types import SimpleNamespace
        sp=importlib.util.spec_from_file_location('profile_script',ROOT/'scripts/client-profile.py');mod=importlib.util.module_from_spec(sp);sp.loader.exec_module(mod)
        common=dict(project=None,repo='/srv/repo',home='/srv/private',bun='/bin/bun',ssh='memory-host',local=False,url=None,bearer_env=None,workspace=None,expected_instance=None,expected_actor=None,allow_capture=False)
        for source in ['UpperCase','with.dot','x'*33,'']:
            with self.assertRaises(ValueError):mod.make_profile(SimpleNamespace(source=source,**common))
        p=mod.make_profile(SimpleNamespace(source='personal-1',**common));self.assertEqual(p['source'],'personal-1');self.assertIn('-oStrictHostKeyChecking=yes',p['server']['args'])
    def test_profile_does_not_disable_ssh_host_key_checking(self):
        from types import SimpleNamespace
        sp=importlib.util.spec_from_file_location('profile_script',ROOT/'scripts/client-profile.py');mod=importlib.util.module_from_spec(sp);sp.loader.exec_module(mod)
        common=dict(project=None,repo="/srv/space's repo",home='/srv/private',bun='/bin/bun',source='default',local=False,url=None,bearer_env=None,workspace=None,expected_instance=None,expected_actor=None,allow_capture=False)
        p=mod.make_profile(SimpleNamespace(ssh='trusted',**common))
        import shlex
        self.assertIn("/srv/space's repo/src/cli.mjs",shlex.split(p['server']['args'][-1]))
        with self.assertRaises(ValueError):mod.make_profile(SimpleNamespace(ssh='-oProxyCommand=bad',**common))
