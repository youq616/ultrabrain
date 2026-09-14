#!/usr/bin/env python3
"""Real CLI/pg_dump/pg_restore plus exact native bytes. Isolated test installation only."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
assert os.environ.get('ULTRABRAIN_TEST_ALLOW_WRITE')=='1', 'Only an isolated synthetic installation is allowed'
assert os.geteuid()!=0, 'Use the ordinary test service account'
os.umask(0o077)
spec=importlib.util.spec_from_file_location('recovery_test_pg',ROOT/'scripts/postgres.py')
pg=importlib.util.module_from_spec(spec);spec.loader.exec_module(pg)
bun=shutil.which('bun');assert bun, 'Bun needed for actual CLI and document fixture'
checks=0

def passed():
    global checks
    checks+=1

def call(*args,success=True):
    p=subprocess.run([bun,str(ROOT/'src/cli.mjs'),'recovery',*map(str,args)],cwd=ROOT,
        capture_output=True,text=True,timeout=180)
    assert (p.returncode==0)==success, 'Recovery CLI exit status unexpected (private logs suppressed)'
    data=json.loads(p.stdout)
    assert data['ok']==success
    assert 'SYNTHETIC_PRIVATE_MARKER' not in p.stdout+p.stderr, 'Private fixture leaked in diagnostic output'
    return data

parent=Path(tempfile.mkdtemp(prefix='ub-recovery-integration-'))
tag=secrets.token_hex(6)
fixture=pg.HOME/'gbrain'/('recovery-fixture-'+tag)
database='ub_restore_recovery_'+tag
try:
    fixture.mkdir(mode=0o700);(fixture/'empty').mkdir(mode=0o700)
    native_bytes=b'\x00\xff\xef\xbb\xbf\r\nSYNTHETIC_PRIVATE_MARKER\r\n'
    (fixture/'blob.bin').write_bytes(native_bytes)
    (fixture/'provider.env').write_bytes(b'KEY=SYNTHETIC_PRIVATE_MARKER\n')
    config_before=(pg.HOME/'gbrain/.gbrain/config.json').read_bytes()
    state_before=(pg.HOME/'postgres/state.json').read_bytes()
    seed=subprocess.run([bun,str(ROOT/'test/recovery-seed.mjs')],cwd=ROOT,capture_output=True,text=True,timeout=90)
    assert seed.returncode==0, 'Document fixture failed (private logs suppressed)'
    identity=json.loads(seed.stdout);passed()
    refused=parent/'refused'
    call('create','--destination',refused,success=False)
    assert not refused.exists();passed()
    target=parent/'set'
    result=call('create','--destination',target,'--include-private-state','--writers-stopped')['result']
    sha=result['manifest_sha256'];assert len(sha)==64 and result['encrypted'] is False;passed()
    call('verify','--directory',target,'--expected-sha',sha);passed()
    stage=parent/'inactive'
    call('stage','--directory',target,'--expected-sha',sha,'--destination',stage)
    assert (stage/'private-state'/fixture.relative_to(pg.HOME)/'blob.bin').read_bytes()==native_bytes
    assert (stage/'private-state'/fixture.relative_to(pg.HOME)/'empty').is_dir()
    assert (stage/'private-state/postgres/state.json').read_bytes()==state_before
    assert (stage/'private-state/gbrain/.gbrain/config.json').read_bytes()==config_before
    assert (stage/'STAGED-NOT-ACTIVE').is_file();passed()
    call('stage','--directory',target,'--expected-sha',sha,'--destination',stage,success=False);passed()
    call('restore-database','--directory',target,'--expected-sha',sha,'--database',database,success=False)
    absent=pg.pg('psql','-X','-tAc',f"SELECT count(*) FROM pg_database WHERE datname='{database}'").stdout.strip()
    assert absent=='0';passed()
    call('restore-database','--directory',target,'--expected-sha',sha,'--database',database,'--trust-source');passed()
    # Existing repository check compares all 27 fingerprints, including original bytea and metadata.
    verified=subprocess.run(['python3',str(ROOT/'test/restore-verify.py'),database],cwd=ROOT,capture_output=True,text=True,timeout=90)
    assert verified.returncode==0, 'Database restoration fingerprints differ'
    assert verified.stdout.count('PASS restoration fingerprint:')==27;passed()
    sql=f"SELECT encode(sha256(content),'hex') FROM ultrabrain.personal_documents WHERE id='{identity['document_id']}'::uuid"
    assert pg.pg('psql','-X','-tAc',sql,'-d',database).stdout.strip()==identity['sha256'];passed()
    call('restore-database','--directory',target,'--expected-sha',sha,'--database',database,'--trust-source',success=False)
    assert pg.pg('psql','-X','-tAc',sql,'-d',database).stdout.strip()==identity['sha256'];passed()
    assert (pg.HOME/'gbrain/.gbrain/config.json').read_bytes()==config_before
    assert (pg.HOME/'postgres/state.json').read_bytes()==state_before
    assert (fixture/'blob.bin').read_bytes()==native_bytes;passed()
    manifest=(target/'manifest.json').read_bytes()
    (target/'manifest.json').write_bytes(manifest+b' ')
    call('verify','--directory',target,'--expected-sha',sha,success=False);passed()
    assert hashlib.sha256(manifest).hexdigest()==sha
    print(json.dumps({'passed':True,'checks':checks,'database_fingerprints':27,
        'scope':'real CLI, managed PostgreSQL, inactive native/config staging; not automatic host cutover'}))
finally:
    # Only the exact random synthetic restore database/fixture owned by this test is removed.
    try:
        pg.pg('dropdb','--if-exists',database)
    finally:
        shutil.rmtree(parent);shutil.rmtree(fixture)
