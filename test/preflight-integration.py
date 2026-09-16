#!/usr/bin/env python3
"""Actual Python/Bun CLI against a bootstrapped synthetic managed installation.

Requires explicit integration-test consent. It briefly stops only that installation's
DB and restores its previous running state. Do not point at real user data.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
assert os.environ.get('ULTRABRAIN_TEST_ALLOW_WRITE')=='1', 'Explicit isolated-test permission required'
assert os.geteuid()!=0, 'Use ordinary synthetic service account'
HOME=Path(os.environ['ULTRABRAIN_HOME'])
bun=shutil.which('bun');assert bun, 'Bun needed for actual entrypoint check'
checks=0

def checked():
    global checks
    checks+=1

def run(args,env=None):
    return subprocess.run(args,cwd=ROOT,env=env or os.environ,capture_output=True,text=True,timeout=20)

def db(action):
    return run([sys.executable,'-B',str(ROOT/'scripts/postgres.py'),action]).returncode

def inspect(command,success=True,extra=None):
    p=run(command,{**os.environ,**(extra or {})})
    assert (p.returncode==0)==success, 'Unexpected preflight status; raw output suppressed'
    assert p.stderr=='', 'Unexpected diagnostic output; raw content suppressed'
    result=json.loads(p.stdout)
    assert result['ok']==success and result['changes_made'] is False
    assert result.get('live_service_verified') is False and result.get('database_connected') is False
    assert result.get('model_called') is False
    for value in [state['app_password'],state['admin_password'],'PREFLIGHT_SYNTHETIC_MODEL_SECRET']:
        assert value not in p.stdout, 'Sensitive fixture entered diagnostic output'
    return result

state_path=HOME/'postgres/state.json'
state=json.loads(state_path.read_bytes())
binding=json.loads((HOME/'postgres/runtime.json').read_bytes())
paths=[state_path,HOME/'postgres/runtime.json',HOME/'gbrain/.gbrain/config.json',HOME/'postgres/data/PG_VERSION',
       HOME/'runtime'/binding['directory']/'.ultrabrain-build']

def fingerprint():
    return [(hashlib.sha256(p.read_bytes()).hexdigest(),p.stat().st_mtime_ns,stat.S_IMODE(p.stat().st_mode)) for p in paths]

assert db('status')==0, 'Integration fixture must already be bootstrapped and running'
original=fingerprint(); original_mode=stat.S_IMODE(state_path.stat().st_mode);stopped=False
python_command=[sys.executable,'-B',str(ROOT/'scripts/preflight.py'),'--mode','runtime']
bun_command=[bun,str(ROOT/'src/cli.mjs'),'preflight','--mode','runtime']
try:
    direct=inspect(python_command);checked()
    via_cli=inspect(bun_command);assert direct['scope']==via_cli['scope'];checked()
    assert fingerprint()==original and db('status')==0;checked()
    inspect(bun_command,extra={'PGHOST':'unreachable.invalid','DATABASE_URL':'postgresql://invalid.invalid/test',
                              'OPENAI_API_KEY':'PREFLIGHT_SYNTHETIC_MODEL_SECRET'});checked()
    assert db('stop')==0;stopped=True
    inspect(bun_command);assert db('status')==3;checked()
    state_path.chmod(0o644)
    try:
        rejected=inspect(bun_command,success=False)
        assert any(c['id']=='database_state' and c['code']=='owner_only_permissions_required' for c in rejected['checks'])
    finally:
        state_path.chmod(original_mode)
    checked()
    inspect(bun_command);assert fingerprint()==original;checked()
    with tempfile.TemporaryDirectory(prefix='ub-preflight-empty-') as temp:
        target=Path(temp)/'never-create'
        rejected=inspect([bun,str(ROOT/'src/cli.mjs'),'preflight','--mode','runtime','--home',str(target)],success=False)
        assert not target.exists()
        assert any(c['code']=='not_installed_no_directory_created' for c in rejected['checks'])
    checked()
finally:
    state_path.chmod(original_mode)
    if stopped:
        assert db('start')==0, 'Could not restore synthetic database running state'
assert fingerprint()==original and db('status')==0;checked()
print(json.dumps({'passed':True,'checks':checks,'fixture':'actual initialized managed PostgreSQL; preflight itself stays offline',
                  'configuration_unchanged':True,'test_service_running_state_restored':True,
                  'live_mcp_or_provider_certification':False}))
