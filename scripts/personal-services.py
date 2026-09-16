#!/usr/bin/env python3
"""Plan/export personal user-systemd units; never install, enable or start a service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
TARGET = 'ultrabrain-personal.target'
CONSOLE = 'ultrabrain-personal-console.service'
WORKER = 'ultrabrain-personal-worker.service'
DATABASE = 'ultrabrain-postgres.service'
INCOMPLETE = 'Incomplete export; do not install.\n'

class ServicePlanError(Exception):
    pass

def need(condition, code):
    if not condition:
        raise ServicePlanError(code)

def absolute(value):
    value = str(value)
    need(value.startswith('/') and value != '/' and len(value.encode('utf-8')) <= 4096
         and not any(ord(c) < 32 or ord(c) == 127 for c in value)
         and all(p not in ('.', '..', '') for p in value.split('/')[1:]), 'invalid_absolute_path')
    return value

def quote(value):
    # systemd quotes are NOT shell quotes. Specifier and ExecStart variable
    # expansion are escaped independently. No shell command is generated.
    value = str(value)
    need(not any(ord(c) < 32 or ord(c) == 127 for c in value), 'invalid_unit_value')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'

def command(*args):
    return ' '.join(quote(v).replace('$', '$$') for v in args)

def render(root, home, bun, *, source='default', port=3132, worker=False,
           allow_model_call=False, interval=300):
    root, home, bun = map(absolute, (root, home, bun))
    need(re.fullmatch(r'[a-z0-9-]{1,32}', source) is not None, 'invalid_source')
    need(type(port) is int and 1024 <= port <= 65535, 'invalid_port')
    need(type(worker) is bool and type(allow_model_call) is bool and worker == allow_model_call,
         'explicit_worker_model_consent_required')
    need(type(interval) is int and 30 <= interval <= 86400, 'invalid_interval')
    # Fixed assignment arguments win over the user manager's environment. No
    # service.env/dotenv file is silently interpreted as service configuration.
    run = ['/usr/bin/env', '-u', 'DATABASE_URL', '-u', 'GBRAIN_DATABASE_URL',
           '-u', 'NODE_OPTIONS', '-u', 'BUN_OPTIONS', '-u', 'PYTHONPATH', '-u', 'PYTHONHOME',
           '--', 'ULTRABRAIN_HOME='+home, 'GBRAIN_SOURCE='+source,
           'GBRAIN_HOME='+home+'/gbrain', 'GBRAIN_SWEEP=0', 'GBRAIN_SELF_UPGRADE_MODE=off',
           'ULTRABRAIN_MCP_PROFILE=compatibility', 'ULTRABRAIN_DEBUG=0',
           bun, '--no-env-file']
    common = f'''Requires={DATABASE}
After={DATABASE}
PartOf={TARGET} {DATABASE}
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=exec
WorkingDirectory=/
UMask=0077
NoNewPrivileges=true
RestrictSUIDSGID=true
StandardInput=null
StandardOutput=journal
StandardError=journal
KillMode=control-group
TimeoutStopSec=90
Restart=on-failure
RestartSec=30
LimitCORE=0
'''
    # Filesystem namespaces are deliberately not promised by these user units.
    # The existing database service's policy is left entirely unchanged.
    console = f'''[Unit]
Description=Ultrabrain personal owner console (loopback only)
{common}ExecStart={command(*run, root+'/src/cli.mjs', 'personal-ui', '--source', source, '--port', port)}

[Install]
WantedBy={TARGET}
'''
    wanted = CONSOLE + (' '+WORKER if worker else '')
    units = {TARGET: f'''[Unit]
Description=Ultrabrain personal services (not a readiness guarantee)
Requires={DATABASE}
Wants={wanted}
After={DATABASE}

[Install]
WantedBy=default.target
''', CONSOLE: console}
    if worker:
        units[WORKER] = f'''[Unit]
Description=Ultrabrain explicitly authorized personal consolidation
{common}RestartPreventExitStatus=2
ExecStart={command(*run, root+'/scripts/personal-worker.mjs', '--local', '--source', source, '--allow-model-call', '--loop', '--limit', 1, '--interval', interval)}

[Install]
WantedBy={TARGET}
'''
    return units

def plan(root, home, bun, **options):
    units = render(root, home, bun, **options)
    body = {'format': 1, 'units': units, 'required_existing_unit': DATABASE,
            'worker_enabled_in_plan': WORKER in units, 'source': options.get('source', 'default'),
            'scope': 'local service owner, not all HTTP principals',
            'changes_made': False, 'services_started': False, 'model_called': False,
            'readiness_verified': False}
    raw = json.dumps(body, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()
    return {**body, 'plan_sha256': hashlib.sha256(raw).hexdigest()}

def open_directory(path, private=False):
    path = absolute(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split('/')[1:]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = new
        st = os.fstat(fd)
        if private:
            need(st.st_uid == os.geteuid() and not st.st_mode & 0o077, 'private_output_parent_required')
        return fd
    except BaseException:
        os.close(fd); raise

def write_file(directory, name, raw):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    with os.fdopen(fd, 'wb') as f:
        f.write(raw); f.flush(); os.fsync(f.fileno())

def check_plan(value, expected):
    body = {k: v for k, v in value.items() if k != 'plan_sha256'}
    raw = json.dumps(body, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()
    need(isinstance(expected, str) and re.fullmatch(r'[a-f0-9]{64}', expected)
         and expected == value.get('plan_sha256') == hashlib.sha256(raw).hexdigest(), 'reviewed_plan_mismatch')
    need(set(value['units']) in ({TARGET, CONSOLE}, {TARGET, CONSOLE, WORKER}), 'invalid_unit_inventory')

def manifest_for(value):
    return {'format': 1, 'plan_sha256': value['plan_sha256'], 'services_started': False,
            'units': {n: hashlib.sha256(t.encode()).hexdigest() for n, t in value['units'].items()}}

def reject_unit_search_path(output):
    """Keep artifact export out of known unit load paths, without querying a manager.

    Defaults and the current process' XDG/SYSTEMD_UNIT_PATH are included. An
    independently configured user manager may have extra paths unknown offline.
    """
    import pwd
    homes = {Path.home(), Path(pwd.getpwuid(os.geteuid()).pw_dir)}
    roots = set()
    def add(path):
        text = str(path)
        need(text.startswith('/') and len(text.encode('utf-8')) <= 4096
             and not any(ord(c) < 32 or ord(c) == 127 for c in text),
             'invalid_unit_search_path')
        roots.add(Path(os.path.abspath(text)))
        # A known load path may itself alias an as-yet uncreated export directory.
        # Resolve path metadata only; never open or execute a unit file here.
        roots.add(Path(os.path.realpath(text)))
    for home in homes:
        for suffix in ('.config/systemd/user', '.config/systemd/user.control',
                       '.local/share/systemd/user'):
            add(home/suffix)
    for key, default, suffixes in (
        ('XDG_CONFIG_HOME', None, ('systemd/user', 'systemd/user.control')),
        ('XDG_DATA_HOME', None, ('systemd/user',)),
        ('XDG_RUNTIME_DIR', '/run/user/'+str(os.geteuid()),
         ('systemd/user', 'systemd/user.control', 'systemd/transient',
          'systemd/generator', 'systemd/generator.early', 'systemd/generator.late')),
    ):
        base = os.environ.get(key) or default
        if base:
            for suffix in suffixes:
                add(Path(base)/suffix)
    # Include the standard runtime path even when this process overrides XDG.
    runtime = Path('/run/user')/str(os.geteuid())/'systemd'
    for suffix in ('user', 'user.control', 'transient', 'generator',
                   'generator.early', 'generator.late'):
        add(runtime/suffix)
    for key, default in (('XDG_CONFIG_DIRS', '/etc/xdg'),
                         ('XDG_DATA_DIRS', '/usr/local/share:/usr/share')):
        text = os.environ.get(key) or default
        need(len(text.encode('utf-8')) <= 32768, 'invalid_unit_search_path')
        for base in text.split(':'):
            if base:
                add(Path(base)/'systemd/user')
    for base in ('/etc/systemd', '/run/systemd', '/usr/local/lib/systemd',
                 '/usr/lib/systemd', '/lib/systemd'):
        for suffix in ('user', 'system', 'system.control', 'transient',
                       'generator', 'generator.early', 'generator.late'):
            add(Path(base)/suffix)
    custom = os.environ.get('SYSTEMD_UNIT_PATH', '')
    need(len(custom.encode('utf-8')) <= 32768, 'invalid_unit_search_path')
    for path in custom.split(':'):
        if path:
            add(path)
    need(not any(output == root or root in output.parents for root in roots),
         'unit_search_path_refused')


def verify_contents(directory, wanted):
    """Validate one descriptor-bound inventory, including changes during the read."""
    initial = os.fstat(directory)
    need(set(os.listdir(directory)) == set(wanted), 'export_inventory_mismatch')
    for name, text in wanted.items():
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                 and before.st_uid == os.geteuid() and not before.st_mode & 0o077,
                 'unsafe_export_file')
            raw = text.encode('utf-8')
            need(before.st_size == len(raw), 'export_content_mismatch')
            got = bytearray()
            while len(got) <= len(raw):
                chunk = os.read(fd, len(raw)+1-len(got))
                if not chunk:
                    break
                got.extend(chunk)
            after = os.fstat(fd)
            need(bytes(got) == raw and (before.st_mtime_ns, before.st_ctime_ns) ==
                 (after.st_mtime_ns, after.st_ctime_ns), 'export_content_mismatch')
            current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            need((current.st_dev, current.st_ino) == (before.st_dev, before.st_ino),
                 'output_path_changed')
        finally:
            os.close(fd)
    final = os.fstat(directory)
    need(set(os.listdir(directory)) == set(wanted)
         and (initial.st_mtime_ns, initial.st_ctime_ns) ==
             (final.st_mtime_ns, final.st_ctime_ns), 'export_inventory_changed')


def export_plan(value, output, expected):
    check_plan(value, expected)
    output = Path(absolute(output))
    reject_unit_search_path(output)
    parent = open_directory(output.parent, private=True)
    dest = None
    try:
        # Exclusive new directory: never edit installed units or overwrite an export.
        os.mkdir(output.name, 0o700, dir_fd=parent)
        os.fsync(parent)
        dest = os.open(output.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        identity = os.fstat(dest)
        write_file(dest, 'INCOMPLETE', INCOMPLETE.encode())
        for name, text in value['units'].items():
            write_file(dest, name, text.encode('utf-8'))
        manifest = manifest_for(value)
        write_file(dest, 'manifest.json', (json.dumps(manifest, indent=2)+'\n').encode())
        verify_contents(dest, {**value['units'], 'INCOMPLETE': INCOMPLETE,
            'manifest.json': json.dumps(manifest, indent=2)+'\n'})
        # Report success only for the same visible directory, not an unlinked handle.
        visible = open_directory(output, private=True)
        try:
            now = os.fstat(visible)
            need((now.st_dev, now.st_ino) == (identity.st_dev, identity.st_ino), 'output_path_changed')
        finally:
            os.close(visible)
        os.fsync(dest)
        os.unlink('INCOMPLETE', dir_fd=dest); os.fsync(dest)
        return {'exported': True, 'plan_sha256': expected, 'unit_names': sorted(value['units']),
                'services_started': False, 'model_called': False, 'installed': False}
    finally:
        if dest is not None:
            os.close(dest)
        os.close(parent)

def verify_export(value, directory, expected):
    check_plan(value, expected)
    fd = open_directory(directory, private=True)
    initial = os.fstat(fd)
    try:
        wanted = {**value['units'], 'manifest.json': json.dumps(manifest_for(value), indent=2)+'\n'}
        verify_contents(fd, wanted)
        visible = open_directory(directory, private=True)
        try:
            st = os.fstat(visible)
            need((st.st_dev, st.st_ino) == (initial.st_dev, initial.st_ino), 'output_path_changed')
        finally:
            os.close(visible)
        return {'verified': True, 'plan_sha256': expected, 'installed': False, 'services_started': False}
    finally:
        os.close(fd)

class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ServicePlanError('invalid_arguments')

def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument('--home', default=os.environ.get('ULTRABRAIN_HOME', str(Path.home()/'.local/share/ultrabrain')))
    parser.add_argument('--bun')
    parser.add_argument('--source', default='default')
    parser.add_argument('--port', type=int, default=3132)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--allow-model-call', action='store_true')
    parser.add_argument('--interval', type=int, default=300)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--output')
    selection.add_argument('--verify')
    parser.add_argument('--expected-plan')
    try:
        args = parser.parse_args(argv)
        need(sys.platform == 'linux' and os.geteuid() != 0, 'ordinary_linux_account_required')
        bun = args.bun or shutil.which('bun')
        need(bun is not None, 'bun_path_required')
        bun = absolute(bun) if args.bun else os.path.abspath(bun)
        need(bool(args.output or args.verify) == bool(args.expected_plan), 'output_requires_reviewed_plan')
        result = plan(ROOT, args.home, bun, source=args.source, port=args.port,
                      worker=args.worker, allow_model_call=args.allow_model_call, interval=args.interval)
        if args.output:
            result = export_plan(result, args.output, args.expected_plan)
        elif args.verify:
            result = verify_export(result, args.verify, args.expected_plan)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=True)); return 0
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e) if isinstance(e, ServicePlanError) else 'service_plan_failed',
                          'services_started': False, 'note': 'No installed units overwritten; retain any INCOMPLETE export.'}))
        return 1

if __name__ == '__main__':
    sys.exit(main())
