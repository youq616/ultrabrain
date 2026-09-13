import contextvars
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import ModuleType
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hermes_support', Path(__file__).with_name('hermes-test-support.py'))
support = importlib.util.module_from_spec(spec); spec.loader.exec_module(support)
plugin = support.load_provider()


class HermesProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        profile = self.home / 'profile.json'; cli = self.home / 'cli.cjs'; cli.write_text('// client fixture'); cli.chmod(0o600)
        p = {'format': 1, 'source': 'default', 'workspace': str(self.home), 'expected_instance': '00000000-0000-4000-8000-000000000001', 'expected_actor': 'a' * 64,
             'server': {'transport': 'stdio', 'command': 'not-run', 'args': []}}
        profile.write_text(json.dumps(p)); profile.chmod(0o600)
        config = self.home / 'ultrabrain.json'
        config.write_text(json.dumps({'format': 1, 'node': sys.executable, 'cli': str(cli), 'profile': str(profile)})); config.chmod(0o600)
        self.profile = profile
        self.provider = plugin.UltrabrainProvider(); self.addCleanup(self.provider.shutdown)
        self.provider._config_path = lambda: config
        self.provider._fetch = lambda _generation: {'source_id': 'default', 'memories': [{'content': 'SYNTHETIC'}]}

    def initialize(self, **extra):
        self.provider.initialize('s', hermes_home=str(self.home), platform='cli', agent_context='primary', agent_workspace=str(self.home), **extra)
        if self.provider._thread: self.provider._thread.join(2)

    def test_available_is_local_only(self):
        with patch.object(plugin.subprocess, 'Popen', side_effect=AssertionError('must not connect')):
            self.assertTrue(self.provider.is_available())
        self.profile.unlink(); self.assertFalse(self.provider.is_available())

    def test_no_gateway_cron_or_subagent_access(self):
        for platform, context in [('telegram', 'primary'), ('cli', 'subagent'), ('cli', 'cron')]:
            self.provider.initialize('s', hermes_home=str(self.home), platform=platform, agent_context=context, agent_workspace=str(self.home))
            self.assertFalse(self.provider._ready)
            self.assertEqual(self.provider.prefetch('PRIVATE'), '')

    def test_workspace_mismatch_stays_disabled(self):
        self.provider.initialize('s', hermes_home=str(self.home), platform='cli', agent_workspace=str(self.home.parent))
        self.assertFalse(self.provider._ready)

    def test_prefetch_tracks_actual_recall_and_does_not_sync_conversations(self):
        self.initialize(); raw = self.provider.prefetch('DO_NOT_SEND_PROMPT', session_id='s')
        self.assertEqual(json.loads(raw)['memories'][0]['content'], 'SYNTHETIC')
        self.assertNotIn('DO_NOT_SEND_PROMPT', raw)
        self.assertEqual(self.provider.recall_status().count, 1)
        self.assertEqual(self.provider.get_tool_schemas(), [])
        self.provider.sync_turn('SECRET USER', 'SECRET ASSISTANT', session_id='s')
        self.provider.on_memory_write('add', 'user', 'SECRET')

    def test_different_session_cannot_consume_current_result(self):
        self.initialize(); self.assertEqual(self.provider.prefetch('q', session_id='other'), '')
        self.assertIsNone(self.provider.recall_status())
        self.assertIn('SYNTHETIC', self.provider.prefetch('q', session_id='s'))

    def test_expired_results_are_not_reused_on_network_failure(self):
        self.initialize(); self.provider._result = ({'memories': [{'content': 'OLD'}]}, time.monotonic() - 60)
        self.provider._fetch = lambda _: None
        self.assertEqual(self.provider.prefetch('q', session_id='s'), '')
        self.assertIsNone(self.provider.recall_status())

    def test_shutdown_discards_a_late_thread_result(self):
        start, release = threading.Event(), threading.Event()
        def fetch(_):
            start.set(); release.wait(2); return {'memories': [{'content': 'LATE'}]}
        self.provider._fetch = fetch
        self.provider.initialize('s', hermes_home=str(self.home), platform='cli', agent_workspace=str(self.home))
        self.assertTrue(start.wait(1)); self.provider.shutdown(); release.set(); self.provider._thread.join(2)
        self.assertIsNone(self.provider._result); self.assertEqual(self.provider.prefetch('q'), '')

    def test_session_switch_fences_old_result_and_keeps_contextvars(self):
        active = contextvars.ContextVar('active_profile', default='wrong')
        active.set('profile-A'); seen = []
        self.provider._fetch = lambda _: seen.append(active.get()) or {'memories': []}
        self.initialize(); self.provider.on_session_switch('new'); self.provider._thread.join(2)
        self.assertEqual(seen, ['profile-A', 'profile-A']); self.assertEqual(self.provider.prefetch('q', session_id='s'), '')

    def test_missing_pins_prevent_automatic_read(self):
        p = json.loads(self.profile.read_text()); p.pop('expected_actor'); self.profile.write_text(json.dumps(p))
        self.assertFalse(self.provider.is_available())

    def test_empty_or_failed_result_has_no_stale_indicator(self):
        self.initialize(); self.provider.prefetch('q', session_id='s'); self.assertIsNotNone(self.provider.recall_status())
        self.provider._result = ({'memories': []}, time.monotonic())
        self.assertEqual(self.provider.prefetch('q', session_id='s'), ''); self.assertIsNone(self.provider.recall_status())

    def test_registration_uses_real_memory_provider_surface(self):
        captured = []
        class Context:
            def register_memory_provider(self, provider): captured.append(provider)
        plugin.register(Context()); self.assertEqual(captured[0].name, 'ultrabrain'); captured[0].shutdown()


    def test_session_switch_during_serialization_discards_old_context(self):
        self.initialize()
        original = plugin.json.dumps
        def change(*args, **kwargs):
            self.provider.on_session_switch('new-session')
            return original(*args, **kwargs)
        with patch.object(plugin.json, 'dumps', side_effect=change):
            self.assertEqual(self.provider.prefetch('q', session_id='s'), '')
        self.assertIsNone(self.provider.recall_status())

    def test_child_output_is_bounded_before_buffering_complete_stream(self):
        child = plugin.subprocess.Popen([sys.executable, '-c', 'import sys;sys.stdin.read();sys.stdout.write("x" * 1000000)'],
                                        stdin=plugin.subprocess.PIPE, stdout=plugin.subprocess.PIPE, stderr=plugin.subprocess.DEVNULL)
        self.assertIsNone(plugin._bounded_output(child, b'{}', timeout=2))
        self.assertIsNotNone(child.poll())

    def test_child_deadline_stops_wedged_client(self):
        child = plugin.subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'],
                                        stdin=plugin.subprocess.PIPE, stdout=plugin.subprocess.PIPE, stderr=plugin.subprocess.DEVNULL)
        self.assertIsNone(plugin._bounded_output(child, b'{}', timeout=0.1))
        self.assertIsNotNone(child.poll())
