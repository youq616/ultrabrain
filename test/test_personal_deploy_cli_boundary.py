"""Account lookup must not precede CLI admission or expose raw lookup errors."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('ub_deploy_cli_boundary',ROOT/'scripts/personal-deploy.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class AccountBoundaryTests(unittest.TestCase):
    def invoke(self,args):
        output=io.StringIO()
        with contextlib.redirect_stdout(output):code=m.main(args)
        return code,json.loads(output.getvalue())

    def test_unsupported_platform_never_queries_account_database(self):
        with patch.object(m.sys,'platform','win32'),patch.object(m.pwd,'getpwuid',side_effect=AssertionError('must not inspect')),patch.object(m,'Context') as context:
            code,value=self.invoke(['status']);self.assertEqual(code,1)
            self.assertEqual(value['error'],'ordinary_linux_account_required');context.assert_not_called()

    def test_invalid_arguments_never_query_account_database(self):
        with patch.object(m.pwd,'getpwuid',side_effect=AssertionError('must not inspect')),patch.object(m,'Context') as context:
            code,value=self.invoke(['unknown']);self.assertEqual(code,1)
            self.assertEqual(value['error'],'invalid_arguments');context.assert_not_called()

    def test_explicit_or_environment_home_does_not_evaluate_unused_account_default(self):
        for args,env in [(['status','--home','/synthetic'],{}),(['status'],{'ULTRABRAIN_HOME':'/synthetic'})]:
            with self.subTest(args=args),patch.object(m.pwd,'getpwuid',side_effect=AssertionError('unused default')), \
                 patch.object(m,'Context') as context,patch.dict(os.environ,env):
                context.return_value.status.return_value={'fixture':True}
                code,value=self.invoke(args);self.assertEqual(code,0);self.assertTrue(value['ok'])
                context.assert_called_once_with('/synthetic')

    def test_unknown_default_account_is_a_redacted_failure_not_a_traceback(self):
        with patch.dict(os.environ,{},clear=True),patch.object(m.pwd,'getpwuid',side_effect=KeyError('SYNTHETIC_LOOKUP_SECRET')),patch.object(m,'Context') as context:
            code,value=self.invoke(['status']);self.assertEqual(code,1)
            self.assertEqual(value['error'],'personal_deployment_failed');context.assert_not_called()
            self.assertNotIn('SYNTHETIC',json.dumps(value))
