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
    def test_rotation_rejects_old_profile_cli_or_interpreter(self):
        old=config.patch('claude-task-hooks',None,self.cmd,task_scopes=['claude-user'])
        for index,value in [(0,'other-node'),(1,str(self.base/'other-client.cjs')),(4,str(self.base/'other-profile.json'))]:
            command=list(self.cmd);command[index]=value
            with self.subTest(argument=index):
                with self.assertRaisesRegex(config.ConfigError,'existing_task_hook_conflict'):
                    config.patch('claude-task-hooks',old,command,task_scopes=['claude-user'])
    def test_duplicate_canonical_groups_refused(self):
        data=json.loads(config.patch('claude-task-hooks',None,self.cmd,task_scopes=['claude-user']))
        data['hooks']['UserPromptSubmit']*=2
        with self.assertRaisesRegex(config.ConfigError,'existing_task_hook_conflict'):
            config.patch('claude-task-hooks',json.dumps(data).encode(),self.cmd,task_scopes=['claude-user'])
    def test_existing_event_matcher_or_options_must_be_canonical(self):
        from copy import deepcopy
        original=json.loads(config.patch('claude-task-hooks',None,self.cmd,task_scopes=['claude-user']))
        variants=[]
        data=deepcopy(original);data['hooks']['Stop']=data['hooks'].pop('UserPromptSubmit');variants.append(data)
        data=deepcopy(original);data['hooks']['UserPromptSubmit'][0]['matcher']='*';variants.append(data)
        data=deepcopy(original);data['hooks']['UserPromptSubmit'][0]['hooks'][0]['async']=True;variants.append(data)
        data=deepcopy(original);data['hooks']['UserPromptSubmit'][0]['hooks'][0]['timeout']=10;variants.append(data)
        for data in variants:
            with self.subTest(data=data):
                with self.assertRaisesRegex(config.ConfigError,'existing_task_hook_conflict'):
                    config.patch('claude-task-hooks',json.dumps(data).encode(),self.cmd,task_scopes=['claude-user'])
    def test_mixed_group_or_requoted_command_refused_not_replaced(self):
        from copy import deepcopy
        original=json.loads(config.patch('claude-task-hooks',None,self.cmd,task_scopes=['claude-user']))
        data=deepcopy(original);data['hooks']['UserPromptSubmit'][0]['hooks'].append({'type':'command','command':'echo unrelated'})
        with self.assertRaisesRegex(config.ConfigError,'existing_task_hook_conflict'):
            config.patch('claude-task-hooks',json.dumps(data).encode(),self.cmd,task_scopes=['claude-user'])
        for spelling in ["'claude-task-hook'", "'claude-'task-hook", 'claude-task\\-hook']:
            data=deepcopy(original);hook=data['hooks']['UserPromptSubmit'][0]['hooks'][0]
            hook['command']=hook['command'].replace('claude-task-hook',spelling)
            with self.subTest(spelling=spelling):
                with self.assertRaisesRegex(config.ConfigError,'existing_task_hook_conflict'):
                    config.patch('claude-task-hooks',json.dumps(data).encode(),self.cmd,task_scopes=['claude-user'])
    def test_actual_conflict_does_not_write_or_create_backups(self):
        self.profile.write_text(json.dumps(profiles.make_profile(self.args())))
        previous=list(self.cmd);previous[-1]=str(self.base/'old-profile.json')
        old=config.patch('claude-task-hooks',None,previous,task_scopes=['claude-user']);self.target.write_bytes(old)
        before={p.name:p.read_bytes() for p in self.base.iterdir() if p.is_file()}
        argv=['--client','claude-task-hooks','--target',str(self.target),'--profile',str(self.profile),'--cli',str(self.cli)]
        for extra in [[],['--apply','--expected-sha',config.digest(old)]]:
            with contextlib.redirect_stdout(io.StringIO()) as output: code=config.main(argv+extra)
            self.assertEqual(code,1);self.assertEqual(json.loads(output.getvalue())['error'],'existing_task_hook_conflict')
            self.assertEqual({p.name:p.read_bytes() for p in self.base.iterdir() if p.is_file()},before)
    def test_other_hooks_preserved_without_new_task_duplicate(self):
        other={'type':'command','command':'echo unrelated','timeout':5}
        data={'permissions':{'allow':['Read']},'hooks':{'Stop':[{'hooks':[other]}]}}
        old=json.dumps(data).encode();new=config.patch('claude-task-hooks',old,self.cmd,task_scopes=['claude-user'])
        self.assertEqual(json.loads(new)['hooks']['Stop'],data['hooks']['Stop'])
        self.assertEqual(config.patch('claude-task-hooks',new,self.cmd,task_scopes=['claude-user']),new)
    def test_explicit_rollback_then_new_profile_is_supported(self):
        old=b'{ "permissions": {} }\r\n';self.target.write_bytes(old)
        initial=config.patch('claude-task-hooks',old,self.cmd,task_scopes=['claude-user'])
        receipt=config.apply(self.target,old,initial,config.digest(old))
        config.rollback(self.target,receipt['rollback_receipt'])
        changed=list(self.cmd);changed[-1]=str(self.base/'rotated-profile.json')
        replacement=config.patch('claude-task-hooks',self.target.read_bytes(),changed,task_scopes=['claude-user'])
        self.assertIn('rotated-profile.json',replacement.decode());self.assertNotEqual(replacement,initial)
if __name__=='__main__':unittest.main()
