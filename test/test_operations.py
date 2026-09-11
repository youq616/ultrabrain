"""Offline operational safety tests. Synthetic paths only; no production mutation."""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def module(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/f'{name}.py')
    value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
pg=module('postgres'); upstream=module('upstreams'); service=module('install-service'); diagnostics=module('pg-diagnostics')

class OperationsTests(unittest.TestCase):
    def test_portable_extension_build_profile_is_explicit(self):
        self.assertTrue(pg.EXPECTED['directory'].endswith('-portable-v1'))
        self.assertIn('OPTFLAGS=""', (ROOT/'scripts/build-postgres.sh').read_text())
    def test_crash_diagnostics_never_print_log_contents(self):
        result=diagnostics.classify('server process was terminated by signal 4: Illegal instruction\nDETAIL: secret password in SQL\nautomatic recovery in progress')
        self.assertEqual(result['backend_termination_signals'],[4])
        self.assertEqual(result['recovery_restarts'],1)
        self.assertNotIn('secret',json.dumps(result))

    def test_annotated_tag_uses_peeled_commit(self):
        lines='a'*40+'\trefs/tags/v1.0.0\n'+'b'*40+'\trefs/tags/v1.0.0^{}\n'
        with patch.object(upstream,'run',return_value=lines):
            self.assertEqual(upstream.refs('test/repo','refs/tags/*')['refs/tags/v1.0.0'],'b'*40)
    def test_upgrade_check_network_errors_are_not_success(self):
        import io
        with patch.object(upstream,'refs',side_effect=OSError('offline')), patch('sys.stdout',new_callable=io.StringIO) as output:
            with self.assertRaises(SystemExit) as caught: upstream.check()
            self.assertEqual(caught.exception.code,2)
            self.assertIn('"checked": false',output.getvalue())
    def test_major_upgrade_refused_before_any_switch(self):
        with tempfile.TemporaryDirectory() as folder:
            data=Path(folder); (data/'PG_VERSION').write_text('17')
            with patch.object(pg,'DATA',data),patch.object(pg,'validate_runtime'),patch.object(pg,'private_write') as write:
                with self.assertRaisesRegex(RuntimeError,'Cross-major'): pg.activate_runtime()
                write.assert_not_called()
    def test_running_cluster_cannot_switch_binary(self):
        with tempfile.TemporaryDirectory() as folder:
            data=Path(folder); (data/'PG_VERSION').write_text(pg.PG['version'].split('.')[0])
            with patch.object(pg,'DATA',data),patch.object(pg,'validate_runtime'),patch.object(pg,'status',return_value=True),patch.object(pg,'private_write') as write:
                with self.assertRaisesRegex(RuntimeError,'Stop MCP'): pg.activate_runtime()
                write.assert_not_called()
    def test_corrupt_backup_rejected_before_database_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder); (path/'database.dump').write_bytes(b'corrupt')
            (path/'manifest.json').write_text(json.dumps({'kind':'database-only','format':2,'dump_sha256':'a'*64}))
            with patch.object(pg,'pg') as execute:
                with self.assertRaisesRegex(RuntimeError,'checksum'): pg.restore_new(path,'ub_restore_corrupt')
                execute.assert_not_called()
    def test_incomplete_backup_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder); (path/'INCOMPLETE').touch()
            with patch.object(pg,'pg') as execute:
                with self.assertRaisesRegex(RuntimeError,'Incomplete'): pg.restore_new(path,'ub_restore_incomplete')
                execute.assert_not_called()
    def test_restore_never_overwrites_primary_database(self):
        with patch.object(pg,'pg') as execute:
            with self.assertRaises(RuntimeError): pg.restore_new('/unused','ultrabrain')
            execute.assert_not_called()
    def test_native_library_path_is_pinned(self):
        with patch.object(pg,'prefix',return_value=Path('/private/runtime')),patch.dict(os.environ,{'LD_LIBRARY_PATH':'/attacker','LD_PRELOAD':'bad.so','PGOPTIONS':'injected'}):
            env=pg.native_env()
            self.assertEqual(env['LD_LIBRARY_PATH'],'/private/runtime/lib')
            self.assertNotIn('LD_PRELOAD',env);self.assertNotIn('PGOPTIONS',env)
    def test_service_localhost_and_dependency(self):
        units=service.render(Path('/app/ultra brain'),Path('/private/brain'),Path('/bin/bun'),Path('/bin/python3'))
        self.assertIn('Requires=ultrabrain-postgres.service',units['ultrabrain-mcp.service'])
        self.assertIn('--bind 127.0.0.1',units['ultrabrain-mcp.service'])
        self.assertIn('NoNewPrivileges=true',units['ultrabrain-mcp.service'])
        self.assertNotIn('0.0.0.0',units['ultrabrain-mcp.service'])
    def test_service_rejects_unsafe_url_and_controls(self):
        for url in ['http://example.com','https://user:password@example.com','https://example.com/?a=b']:
            with self.assertRaises(ValueError): service.render(Path('/app'),Path('/private'),Path('/bin/bun'),Path('/bin/python3'),public_url=url)
        with self.assertRaises(ValueError): service.quote('/app\nExecStart=/evil')
    def test_service_escapes_specifiers(self):
        self.assertEqual(service.exec_quote('/a/%i/$HOME'),'"/a/%%i/$$HOME"')
        self.assertEqual(service.quote('/a/%i/$HOME'),'"/a/%%i/$HOME"')

class UpstreamSafetyTests(unittest.TestCase):
    def test_project_checks_are_independent(self):
        import io
        def response(repo, pattern):
            if repo=='youq616/gbrain': raise OSError('offline')
            return {pattern:'b'*40}
        with patch.object(upstream,'refs',side_effect=response),patch('sys.stdout',new_callable=io.StringIO) as output:
            with self.assertRaises(SystemExit): upstream.check('gbrain')
            report=json.loads(output.getvalue());self.assertEqual(set(report['projects']),{'gbrain'})
            p=report['projects']['gbrain'];self.assertTrue(p['origins']['garrytan/gbrain']['changed'])
            self.assertFalse(p['origins']['youq616/gbrain']['checked'])
    def test_tracking_ref_is_not_changed_with_release_pin(self):
        import io
        p={'gbrain':dict(upstream.projects()['gbrain'],ref='refs/tags/v1',tracking_ref='refs/heads/master')}
        with patch.object(upstream,'projects',return_value=p),patch.object(upstream,'refs',return_value={'refs/heads/master':'b'*40}) as refs,patch('sys.stdout',new_callable=io.StringIO):
            upstream.check('gbrain')
            self.assertTrue(all(c.args[1]=='refs/heads/master' for c in refs.call_args_list))
    def test_install_source_probe_uses_fresh_bare_repo_without_checkout(self):
        sha='a'*40
        with patch.object(upstream,'run',side_effect=['','',sha]) as run:
            self.assertTrue(upstream.prove_install_source('https://github.com/youq616/gbrain.git',sha))
            commands=[c.args for c in run.call_args_list]
            self.assertIn('--bare',commands[0]);self.assertIn('--depth=1',commands[1]);self.assertNotIn('checkout',str(commands))
    def test_install_source_probe_rejects_local_paths_and_wrong_resolution(self):
        for url in ['/local/repo','file:///tmp/repo','https://attacker.example/repo']:
            with self.assertRaises(RuntimeError):upstream.prove_install_source(url,'a'*40)
        with patch.object(upstream,'run',side_effect=['','','b'*40]):
            with self.assertRaises(RuntimeError):upstream.prove_install_source('https://github.com/x/y','a'*40)
    def test_risk_routing_never_labels_unknown_changes_safe(self):
        flags=upstream.classify_changes('gbrain',['src/auth/policy.ts','src/migrate.ts','LICENSE'])
        self.assertIn('authorization-review',flags);self.assertIn('data-migration-review',flags);self.assertIn('license-review',flags)
        self.assertIn('source-review-required',upstream.classify_changes('gbrain',['unrecognized/file']))
    def test_candidate_workflow_does_not_build_with_write_credentials(self):
        text=(ROOT/'.github/workflows/upstream-candidate.yml').read_text()
        self.assertIn('persist-credentials: false',text);self.assertIn('github.event.repository.default_branch',text)
        self.assertNotIn('bun install',text);self.assertNotIn('pull_request_target:',text)

class MappingTests(unittest.TestCase):
    def test_mapping_paths_and_baselines_exist(self):
        data=json.loads((ROOT/'compat/upstream-features.json').read_text())
        for feature in data['features']:
            self.assertEqual(len(feature['baseline']),40)
            for path in feature['local_files']+feature['tests']:self.assertTrue((ROOT/path).is_file(),path)
    def test_changed_paths_route_to_local_features(self):
        self.assertIn('hierarchical-retrieval',upstream.affected_features('openviking',['openviking/retrieve/hierarchical_retriever.py']))
        self.assertEqual(upstream.affected_features('gbrain',['unrecognized/file']),[])

if __name__=='__main__': unittest.main()
