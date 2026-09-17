"""Task query opt-in only. Synthetic private paths, no installed Agent modification."""
import contextlib
import importlib.util
import io
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
class TaskContextConfigTests(unittest.TestCase):
    def setUp(self):
        previous=os.umask(0o077);self.addCleanup(os.umask,previous)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.base=Path(self.temp.name)
        self.workspace=self.base/'work';self.workspace.mkdir()
        self.cli=self.base/'cli.cjs';self.cli.write_text('// synthetic client')
        self.profile=self.base/'profile.json';self.target=self.base/'settings.local.json'
        self.cmd=['node',str(self.cli),'mcp','--profile',str(self.profile)]
    def args(self,**overrides):
        return SimpleNamespace(**(dict(source='default',project='alpha',repo='/srv/repo',home='/srv/private',bun='/bin/bun',ssh='trusted',local=False,url=None,bearer_env=None,
            workspace=str(self.workspace),expected_instance='11111111-1111-4111-8111-111111111111',expected_actor='a'*64,allow_capture=False,
            allow_task_context=True,automatic_task_context=['claude-user'],outbox=None,automatic_capture=[])|overrides))
    def test_generator_requires_pins_and_separate_permission(self):
        for kwargs in [dict(allow_task_context=False),dict(workspace=None),dict(expected_actor=None),dict(expected_instance=None),dict(automatic_task_context=['unknown']),dict(automatic_task_context=['claude-user','claude-user'])]:
            with self.assertRaises(ValueError):profiles.make_profile(self.args(**kwargs))
    def test_default_legacy_profile_does_not_authorize_tasks(self):
        p=profiles.make_profile(self.args(allow_task_context=False,automatic_task_context=[]))
        self.assertNotIn('allow_task_context',p);self.assertNotIn('automatic_task_context',p)
    def test_generated_task_profile_never_enables_writes(self):
        p=profiles.make_profile(self.args());self.assertTrue(p['allow_task_context']);self.assertFalse(p['allow_capture']);self.assertFalse(p['allow_documents']);self.assertNotIn('outbox_directory',p)
    def test_manual_task_profile_does_not_authorize_automatic_prompt(self):
        p=profiles.make_profile(self.args(automatic_task_context=[]));self.assertTrue(p['allow_task_context']);self.assertNotIn('automatic_task_context',p)
    def test_only_prompt_hook_is_added_permissions_preserved_and_idempotent(self):
        old=b'{"permissions":{"allow":["Read"]},"hooks":{"Stop":[]}}'
        new=config.patch('claude-task-hooks',old,self.cmd,task_scopes=['claude-user']);data=json.loads(new)
        self.assertEqual(data['permissions'],{'allow':['Read']});self.assertEqual(list(data['hooks']),['Stop','UserPromptSubmit'])
        self.assertIn('claude-task-hook',data['hooks']['UserPromptSubmit'][0]['hooks'][0]['command'])
        self.assertEqual(config.patch('claude-task-hooks',new,self.cmd,task_scopes=['claude-user']),new)
    def test_disabled_or_unscoped_hook_not_installed(self):
        for old,scopes in [(b'{"disableAllHooks":true}',['claude-user']),(None,[])]:
            with self.assertRaises(config.ConfigError):config.patch('claude-task-hooks',old,self.cmd,task_scopes=scopes)
    def test_apply_then_rollback_restores_original_bytes(self):
        old=b'{ "permissions": {} }\r\n';self.target.write_bytes(old)
        new=config.patch('claude-task-hooks',old,self.cmd,task_scopes=['claude-user'])
        receipt=config.apply(self.target,old,new,config.digest(old));config.rollback(self.target,receipt['rollback_receipt']);self.assertEqual(self.target.read_bytes(),old)
    def test_actual_config_cli_checks_profile_scope_before_writing(self):
        self.profile.write_text(json.dumps(profiles.make_profile(self.args(automatic_task_context=[]))))
        with contextlib.redirect_stdout(io.StringIO()):code=config.main(['--client','claude-task-hooks','--target',str(self.target),'--profile',str(self.profile),'--cli',str(self.cli)])
        self.assertEqual(code,1);self.assertFalse(self.target.exists())
    def test_actual_config_plan_and_apply(self):
        self.profile.write_text(json.dumps(profiles.make_profile(self.args())))
        argv=['--client','claude-task-hooks','--target',str(self.target),'--profile',str(self.profile),'--cli',str(self.cli)]
        with contextlib.redirect_stdout(io.StringIO()):code=config.main(argv)
        self.assertEqual(code,0);self.assertFalse(self.target.exists())
        with contextlib.redirect_stdout(io.StringIO()):code=config.main(argv+['--apply','--expected-sha','absent'])
        self.assertEqual(code,0);self.assertIn('claude-task-hook',self.target.read_text())
if __name__=='__main__':unittest.main()
