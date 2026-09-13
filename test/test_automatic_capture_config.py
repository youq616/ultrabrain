"""Only temporary configs and synthetic paths; no real Agent modification."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
ROOT=Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/f'{name}.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
config=load('client-config');profiles=load('client-profile')
class AutomaticCaptureConfigTests(unittest.TestCase):
    def setUp(self):
        previous=os.umask(0o077);self.addCleanup(os.umask,previous)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.base=Path(self.temp.name)
        self.workspace=self.base/'work';self.workspace.mkdir()
        self.cmd=['node',str(self.base/'cli.cjs'),'mcp','--profile',str(self.base/'profile.json')]
    def args(self,**overrides):
        values=dict(source='default',project=None,repo='/srv/repo',home='/srv/private',bun='/bin/bun',ssh='trusted',local=False,url=None,bearer_env=None,
                    workspace=str(self.workspace),expected_instance='11111111-1111-4111-8111-111111111111',expected_actor='a'*64,allow_capture=True,
                    outbox=str(self.base/'queue'),automatic_capture=['claude-user','opencode-user'])
        return SimpleNamespace(**(values|overrides))
    def test_generator_requires_separate_scope_consent_and_pins(self):
        p=profiles.make_profile(self.args());self.assertEqual(p['automatic_capture'],['claude-user','opencode-user'])
        for kwargs in [dict(allow_capture=False),dict(outbox=None),dict(workspace=None),dict(expected_actor=None),dict(automatic_capture=['unknown'])]:
            with self.assertRaises(ValueError):profiles.make_profile(self.args(**kwargs))
    def test_spool_inside_agent_workspace_refused(self):
        with self.assertRaises(ValueError):profiles.make_profile(self.args(outbox=str(self.workspace/'queue')))
    def test_only_explicit_claude_event_kinds_are_registered(self):
        p=json.loads(config.patch('claude-capture-hooks',b'{"permissions":{"allow":["Read"]}}',self.cmd,['claude-user']))
        self.assertEqual(list(p['hooks']),['UserPromptSubmit']);self.assertEqual(p['permissions'],{'allow':['Read']})
        self.assertIn('claude-capture-hook',p['hooks']['UserPromptSubmit'][0]['hooks'][0]['command'])
    def test_capture_and_read_hooks_coexist_and_merge_idempotently(self):
        old=config.patch('claude-hooks',None,self.cmd)
        new=config.patch('claude-capture-hooks',old,self.cmd,['claude-user','claude-assistant'])
        data=json.loads(new);self.assertEqual(len(data['hooks']['UserPromptSubmit']),2);self.assertIn('Stop',data['hooks'])
        self.assertEqual(config.patch('claude-capture-hooks',new,self.cmd,['claude-user','claude-assistant']),new)
    def test_disabled_hooks_are_not_reenabled(self):
        with self.assertRaises(config.ConfigError):config.patch('claude-capture-hooks',b'{"disableAllHooks":true}',self.cmd,['claude-user'])
    def test_capture_hook_configuration_can_restore_original_bytes(self):
        target=self.base/'settings.local.json';old=b'{ "permissions": {} }\r\n';target.write_bytes(old)
        new=config.patch('claude-capture-hooks',old,self.cmd,['claude-user']);result=config.apply(target,old,new,config.digest(old));config.rollback(target,result['rollback_receipt']);self.assertEqual(target.read_bytes(),old)
    def test_actual_cli_refuses_unapproved_profile(self):
        import contextlib,io
        Path(self.cmd[1]).write_text('// fixture');Path(self.cmd[-1]).write_text('{"format":1}')
        with contextlib.redirect_stdout(io.StringIO()):code=config.main(['--client','claude-capture-hooks','--cli',self.cmd[1],'--profile',self.cmd[-1],'--target',str(self.base/'settings.json')])
        self.assertEqual(code,1);self.assertFalse((self.base/'settings.json').exists())
