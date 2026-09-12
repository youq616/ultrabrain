#!/usr/bin/env python3
"""Real old-to-new vector SQL schema upgrade in a disposable native PostgreSQL cluster.
Both schemas use the current pinned C library. This is NOT a binary-ABI migration test.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
assert os.environ.get('ULTRABRAIN_TEST_ALLOW_WRITE') == '1'
assert os.geteuid() != 0, 'Use a non-root isolated test account'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


current = load('current_pg', ROOT / 'scripts/postgres.py')
source_runtime = current.prefix()
fixture = json.loads((ROOT / 'compat/vector-upgrade-fixture.json').read_text())
assert current.VECTOR['version'] == fixture['target'], 'Review the SQL migration fixture when the target pin changes'
base_script = (source_runtime / 'share/extension' / f"vector--{fixture['target']}.sql").read_bytes()
blob_hash = hashlib.sha1(b'blob ' + str(len(base_script)).encode() + b'\0' + base_script).hexdigest()
assert blob_hash == fixture['source_sql_git_blob'], 'Fixture source must be the independently verified upstream SQL blob'
checks = 0


def check(condition=True):
    global checks
    assert condition
    checks += 1


def copy_link(source, target):
    try:
        return os.link(source, target)
    except OSError:
        return shutil.copy2(source, target)


with tempfile.TemporaryDirectory(prefix='ub-vector-sql-') as temporary:
    home = Path(temporary) / 'home'
    home.mkdir(mode=0o700)
    runtime = home / 'runtime' / source_runtime.name
    shutil.copytree(source_runtime, runtime, copy_function=copy_link, symlinks=True)
    runtime.chmod(0o700)
    (home / 'postgres').mkdir(mode=0o700)
    binding = current.read_runtime()
    marker = home / 'postgres/runtime.json'
    marker.write_text(json.dumps(binding))
    marker.chmod(0o600)
    control = runtime / 'share/extension/vector.control'
    original_control = control.read_text()
    # Never edit a hard-linked source file in place.
    control.unlink()
    control.write_text(original_control.replace(f"default_version = '{fixture['target']}'", f"default_version = '{fixture['source']}'"))
    assert f"default_version = '{fixture['source']}'" in control.read_text()
    (runtime / 'share/extension' / f"vector--{fixture['source']}.sql").write_bytes(base_script)
    prior_home = os.environ.get('ULTRABRAIN_HOME')
    os.environ['ULTRABRAIN_HOME'] = str(home)
    pg = load('isolated_pg', ROOT / 'scripts/postgres.py')
    child = None
    try:
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        sock.close()
        pg.init(port)
        control.write_text(original_control)
        vector = load('isolated_vector', ROOT / 'scripts/vector-upgrade.py')
        cli = [sys.executable, str(ROOT / 'scripts/vector-upgrade.py')]

        def run(*args, success=True):
            process = subprocess.run([*cli, *args], text=True, capture_output=True, timeout=30)
            assert (process.returncode == 0) == success, process.stderr[-1000:]
            return json.loads(process.stdout) if success else process

        before = run('vector-plan')
        check(before['installed'] == fixture['source'] and before['update_required'])
        vector.execute("CREATE TABLE vector_fixture(id integer PRIMARY KEY, v vector(3)); "
                       "INSERT INTO vector_fixture VALUES(1,'[1,2,3]'),(2,'[4,5,6]'); "
                       "CREATE INDEX vector_fixture_hnsw ON vector_fixture USING hnsw(v vector_l2_ops)", 'ultrabrain')
        fingerprint = vector.execute("SELECT md5(string_agg(id::text||':'||v::text,',' ORDER BY id)) FROM vector_fixture", 'ultrabrain')
        run('vector-upgrade', '--from-version', fixture['source'], success=False)
        check(run('vector-plan')['installed'] == fixture['source'])
        run('vector-upgrade', '--from-version', '0.0.1', '--confirm-maintenance', success=False)
        check(not vector.marker_path().exists())
        # Existing app sessions must be refused, not killed by the updater.
        state = pg.state()
        child = subprocess.Popen([pg.binary('psql'), '-X', '-tAc', 'SELECT pg_sleep(30)'],
            env=pg.native_env(PGHOST='127.0.0.1', PGHOSTADDR='127.0.0.1', PGPORT=str(port),
                             PGUSER='ultrabrain', PGPASSWORD=state['app_password'], PGDATABASE='ultrabrain'),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if int(vector.execute("SELECT count(*) FROM pg_stat_activity WHERE datname='ultrabrain' AND usename='ultrabrain'")):
                break
            time.sleep(0.02)
        else:
            raise AssertionError('Fixture client did not connect')
        run('vector-upgrade', '--from-version', fixture['source'], '--confirm-maintenance', success=False)
        check(child.poll() is None and run('vector-plan')['application_login'])
        child.send_signal(signal.SIGINT)
        child.wait(timeout=5)
        child = None
        for _ in range(100):
            if int(vector.execute("SELECT count(*) FROM pg_stat_activity WHERE datname='ultrabrain'")) == 0:
                break
            time.sleep(0.02)
        else:
            raise AssertionError('Fixture session did not disconnect')
        # Deliberately exit after login fencing, before backup: actual finally bypass / crash recovery.
        crash = f"import importlib.util,os; s=importlib.util.spec_from_file_location('v',{str(ROOT/'scripts/vector-upgrade.py')!r}); v=importlib.util.module_from_spec(s); s.loader.exec_module(v); v.capture_backup=lambda *a: os._exit(91); v.upgrade({fixture['source']!r},True)"
        exited = subprocess.run([sys.executable, '-c', crash], capture_output=True, timeout=15)
        assert exited.returncode == 91, exited.stderr.decode()[-1000:]
        check()
        check(vector.marker_path().exists() and not run('vector-plan')['application_login'])
        run('vector-recover', success=False)
        check(not run('vector-plan')['application_login'])
        recovery = run('vector-recover', '--confirm-maintenance')
        check(recovery['recovered_login'] and not recovery['schema_changed'] and not vector.marker_path().exists())
        # Inject a failing statement only into the disposable runtime's declared update script.
        update_path = runtime / 'share/extension' / f"vector--{fixture['source']}--{fixture['target']}.sql"
        update_body = update_path.read_bytes()
        update_path.unlink()
        update_path.write_bytes(update_body + b'\nSELECT 1/0;\n')
        run('vector-upgrade', '--from-version', fixture['source'], '--confirm-maintenance',
            '--backup-destination', str(Path(temporary)/'failed-backup'), success=False)
        failed = run('vector-plan')
        check(failed['installed'] == fixture['source'] and failed['application_login'])
        check(fingerprint == vector.execute("SELECT md5(string_agg(id::text||':'||v::text,',' ORDER BY id)) FROM vector_fixture", 'ultrabrain'))
        update_path.write_bytes(update_body)
        destination = Path(temporary)/'upgrade-backup'
        upgraded = run('vector-upgrade', '--from-version', fixture['source'], '--confirm-maintenance', '--backup-destination', str(destination))
        check(upgraded['changed'] and upgraded['version'] == fixture['target'])
        after = run('vector-plan')
        check(not after['update_required'] and after['application_login'] and not vector.marker_path().exists())
        check(fingerprint == vector.execute("SELECT md5(string_agg(id::text||':'||v::text,',' ORDER BY id)) FROM vector_fixture", 'ultrabrain'))
        check(vector.execute("SELECT (v <-> '[1,2,3]')::text FROM vector_fixture WHERE id=1", 'ultrabrain') == '0')
        check(run('vector-upgrade', '--from-version', fixture['target'], '--confirm-maintenance')['changed'] is False)
        manifest = json.loads((destination/'manifest.json').read_text())
        check(manifest['dump_sha256'] == pg.file_hash(destination/'database.dump') and manifest['extension_versions']['vector'] == fixture['source'])
        pg.restore_new(destination, 'ub_restore_vector')
        check(fingerprint == vector.execute("SELECT md5(string_agg(id::text||':'||v::text,',' ORDER BY id)) FROM vector_fixture", 'ub_restore_vector'))
        print(f"PASS {checks} real pgvector SQL upgrade checks ({fixture['source']} -> {fixture['target']}); current pinned C library, not cross-binary ABI proof")
    finally:
        if child and child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
        try:
            pg.stop()
        finally:
            if prior_home is None:
                os.environ.pop('ULTRABRAIN_HOME', None)
            else:
                os.environ['ULTRABRAIN_HOME'] = prior_home
