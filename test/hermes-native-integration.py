"""Provider -> actual Node client -> native MCP/PostgreSQL. No Hermes inference model."""
import importlib.util
import json
import os
from pathlib import Path
import time

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('hermes-test-support.py'))
support = importlib.util.module_from_spec(spec); spec.loader.exec_module(support)
plugin = support.load_provider(); provider = plugin.UltrabrainProvider()
home = os.environ['ULTRABRAIN_NATIVE_HERMES_HOME']; workspace = os.environ['ULTRABRAIN_NATIVE_WORKSPACE']
try:
    provider._config_path = lambda: Path(home) / 'ultrabrain.json'
    assert provider.is_available()
    provider.initialize('synthetic', hermes_home=home, platform='cli', agent_context='primary', agent_workspace=workspace)
    assert provider._ready
    provider._thread.join(timeout=15)
    result = provider.prefetch('THIS_PROMPT_MUST_NOT_BE_SENT', session_id='synthetic')
    assert 'NATIVE_ADAPTER_CANARY' in result and 'THIS_PROMPT_MUST_NOT_BE_SENT' not in result
    assert provider.recall_status().count == 1
    assert provider.prefetch('q', session_id='other') == ''
    # Profile changes are not silently adopted by the live provider.
    profile = Path(provider._options['profile']); old = profile.read_bytes()
    changed = json.loads(old); changed['source'] = 'other-source'
    profile.write_text(json.dumps(changed), encoding='utf-8')
    try:
        assert provider._fetch(provider._generation) is None
    finally:
        profile.write_bytes(old)
    provider.shutdown()
    assert provider.prefetch('q') == ''
    print(json.dumps({'passed': True, 'checks': 6, 'upstream_abc': bool(os.environ.get('ULTRABRAIN_HERMES_REFERENCE')),
                      'scope': 'Provider and real Node/MCP/database; host interface fixture unless upstream_abc is true'}))
finally:
    provider.shutdown()
