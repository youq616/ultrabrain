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
pg=module('postgres'); upstream=module('upstreams'); service=module('install-service')

class OperationsTests(unittest.TestCase):
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
if __name__=='__main__': unittest.main()
