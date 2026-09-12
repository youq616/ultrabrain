import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import postgres as pg
spec=importlib.util.spec_from_file_location('configure_summary',ROOT/'scripts/configure-summary.py')
summary=importlib.util.module_from_spec(spec);spec.loader.exec_module(summary)

class ConfigAlignmentTests(unittest.TestCase):
    def setup_home(self,folder):
        home=Path(folder);(home/'gbrain').mkdir(mode=0o700)
        legacy={'engine':'postgres','database_url':'postgresql://fixture','embedding_model':'openai:test','embedding_dimensions':1536}
        pg.private_write(home/'gbrain/config.json',json.dumps(legacy))
        return home,legacy
    def test_existing_database_embedding_identity_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            home,legacy=self.setup_home(folder)
            calls=[types.SimpleNamespace(stdout='t'),types.SimpleNamespace(stdout=json.dumps({'embedding_model':'old:model','embedding_dimensions':'1280'}))]
            with patch.object(pg,'HOME',home),patch.object(pg,'pg',side_effect=calls):pg.align_native_config(legacy['database_url'])
            actual=json.loads((home/'gbrain/.gbrain/config.json').read_text())
            self.assertEqual(actual['embedding_model'],'old:model');self.assertEqual(actual['embedding_dimensions'],1280)
            self.assertEqual(json.loads((home/'gbrain/config.json').read_text()),legacy)
    def test_fresh_install_uses_intended_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            home,legacy=self.setup_home(folder)
            with patch.object(pg,'HOME',home),patch.object(pg,'pg',return_value=types.SimpleNamespace(stdout='f')):pg.align_native_config(legacy['database_url'])
            self.assertEqual(json.loads((home/'gbrain/.gbrain/config.json').read_text()),legacy)
    def test_existing_native_configuration_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            home,legacy=self.setup_home(folder);target=home/'gbrain/.gbrain/config.json'
            actual=dict(legacy,chat_model='configured:model');pg.private_write(target,json.dumps(actual))
            with patch.object(pg,'HOME',home),patch.object(pg,'pg') as call:pg.align_native_config(legacy['database_url']);call.assert_not_called()
            self.assertEqual(json.loads(target.read_text()),actual)
            actual['database_url']='postgresql://external';pg.private_write(target,json.dumps(actual))
            with patch.object(pg,'HOME',home):
                with self.assertRaises(RuntimeError):pg.align_native_config(legacy['database_url'])
    def test_summary_configuration_keeps_other_values_and_has_no_implicit_model(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'config.json';pg.private_write(path,json.dumps({'chat_model':'openai:existing','secret':'unchanged'}))
            result=summary.configure(path,from_chat=True,revision='1')
            self.assertEqual(result['model_calls'],0)
            value=json.loads(path.read_text());self.assertEqual(value['secret'],'unchanged');self.assertTrue(value['ultrabrain_semantics']['enabled'])
            self.assertTrue(list(path.parent.glob('config.before-summary-*.json')))
            summary.configure(path,disabled=True);self.assertFalse(json.loads(path.read_text())['ultrabrain_semantics']['enabled'])
            with self.assertRaises(RuntimeError):summary.configure(path,model='https://user:secret@host',revision='1')
if __name__=='__main__':unittest.main()
