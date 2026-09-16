#!/usr/bin/env python3
"""Generate user-systemd units for the managed database and loopback MCP server."""
import argparse
import hashlib
import json
import secrets
import stat
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]

def quote(value):
    value = str(value)
    if any(ord(c) < 32 or ord(c) == 127 for c in value): raise ValueError('Control characters are forbidden in unit paths')
    # Unit specifiers and ExecStart environment expansion are separate from shell quoting.
    return '"' + value.replace('\\','\\\\').replace('"','\\"').replace('%','%%') + '"'

def literal_path(value):
    value=str(value)
    if any(ord(c)<32 or ord(c) == 127 for c in value): raise ValueError('Control characters are forbidden in unit paths')
    return value.replace('%','%%')

def exec_quote(value):
    return quote(value).replace('$','$$')

def render(root, home, bun, python, port=3131, public_url=None, profile='compatibility'):
    if profile not in ('compatibility','governed'): raise ValueError('Invalid MCP profile')
    if not 1024 <= port <= 65535: raise ValueError('Port must be 1024..65535')
    if public_url:
        url=urlsplit(public_url)
        if url.scheme!='https' or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('Public URL must be an HTTPS origin without credentials, query or fragment')
    command = f'{exec_quote(bun)} {exec_quote(root / "src/cli.mjs")}'
    manager = f'{exec_quote(python)} {exec_quote(root / "scripts/postgres.py")}'
    common = f'''WorkingDirectory={literal_path(root)}
Environment={quote('ULTRABRAIN_HOME='+str(home))}
Environment=GBRAIN_SELF_UPGRADE_MODE=off
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths={quote(home)}
RestrictSUIDSGID=true
'''
    database = f'''[Unit]
Description=Ultrabrain managed PostgreSQL

[Service]
Type=oneshot
RemainAfterExit=yes
{common}ExecStart={manager} start
ExecStop={manager} stop
TimeoutStartSec=90
TimeoutStopSec=90

[Install]
WantedBy=default.target
'''
    profile_arg = ' --profile governed' if profile=='governed' else ''
    extra = ' --public-url '+exec_quote(public_url) if public_url else ''
    mcp = f'''[Unit]
Description=Ultrabrain authenticated MCP on loopback
Requires=ultrabrain-postgres.service
After=ultrabrain-postgres.service

[Service]
Type=simple
{common}EnvironmentFile=-{literal_path(home / 'service.env')}
ExecStartPre={command} migrate
ExecStart={command} mcp{profile_arg} --http --bind 127.0.0.1 --port {port} --suppress-bootstrap-token{extra}
Restart=on-failure
RestartSec=5
TimeoutStartSec=180
TimeoutStopSec=30

[Install]
WantedBy=default.target
'''
    return {'ultrabrain-postgres.service':database,'ultrabrain-mcp.service':mcp}

def render_personal(root, home, bun, python, *, source='default', console_port=3132,
                    http_port=None, interval=None, allow_model_call=False, batch_limit=1):
    """One local owner's services. Rendering is not activation or per-record consent."""
    import re
    if not isinstance(source, str) or not re.fullmatch(r'[a-z0-9-]{1,32}', source):
        raise ValueError('Invalid personal source')
    if type(console_port) is not int or not 1024 <= console_port <= 65535:
        raise ValueError('Invalid console port')
    if http_port is not None and (type(http_port) is not int or not 1024 <= http_port <= 65535 or http_port == console_port):
        raise ValueError('HTTP and console need distinct valid ports')
    if type(batch_limit) is not int or not 1 <= batch_limit <= 4:
        raise ValueError('Batch limit must be 1..4')
    if interval is not None and (type(interval) is not int or not 30 <= interval <= 86400 or allow_model_call is not True):
        raise ValueError('Scheduled consolidation requires interval 30..86400 and explicit model-call consent')
    if interval is None and (allow_model_call or batch_limit != 1):
        raise ValueError('Model consent and batch limit require an explicit consolidation interval')
    for value in (root, home, bun, python):
        if not Path(value).is_absolute(): raise ValueError('Service paths must be absolute')
        # systemd path directives and ExecStart use different unquoting rules.
        # Keep supported paths unambiguous instead of silently changing their meaning.
        if any(c in str(value) for c in ('\\', '"')) or str(value).strip()!=str(value):
            raise ValueError('Ambiguous systemd path; use paths without backslash, double quote or edge whitespace')
        quote(value)
    # Exactly reuse the reviewed database unit: stopping personal.target intentionally
    # leaves the database up for maintenance/backup. No second PG manager is started.
    units = {'ultrabrain-postgres.service': render(root, home, bun, python)['ultrabrain-postgres.service']}
    # EnvironmentFile is trusted operator configuration. Fix the destination AFTER it
    # is loaded, so even an accidental ULTRABRAIN_HOME override cannot redirect these units.
    env = f'/usr/bin/env {exec_quote("ULTRABRAIN_HOME="+str(home))} GBRAIN_SWEEP=0 ULTRABRAIN_MCP_PROFILE=compatibility'
    cli = f'{env} {exec_quote(bun)} {exec_quote(root / "src/cli.mjs")}'
    common = f'''Requires=ultrabrain-postgres.service
After=ultrabrain-postgres.service
PartOf=ultrabrain-personal.target

[Service]
WorkingDirectory={literal_path(root)}
Environment={quote('ULTRABRAIN_HOME='+str(home))}
Environment=GBRAIN_SWEEP=0
Environment=GBRAIN_SELF_UPGRADE_MODE=off
EnvironmentFile=-{literal_path(home / 'service.env')}
UMask=0077
NoNewPrivileges=true
KillMode=control-group
TimeoutStopSec=30
'''
    console = f'''[Unit]
Description=Ultrabrain local-owner personal console
{common}Type=simple
ExecStart={cli} personal-ui --source {source} --port {console_port}
Restart=on-failure
RestartSec=5
'''
    units['ultrabrain-personal-console.service'] = console
    wanted = ['ultrabrain-personal-console.service']
    if http_port is not None:
        units['ultrabrain-personal-mcp.service'] = f'''[Unit]
Description=Ultrabrain optional authenticated personal MCP on loopback
{common}Type=simple
ExecStart={cli} mcp --http --bind 127.0.0.1 --port {http_port} --suppress-bootstrap-token
Restart=on-failure
RestartSec=5
'''
        wanted.append('ultrabrain-personal-mcp.service')
    if interval is not None:
        worker = f'{env} {exec_quote(bun)} {exec_quote(root / "scripts/personal-worker.mjs")}'
        units['ultrabrain-personal-worker.service'] = f'''[Unit]
Description=Ultrabrain explicitly authorized personal consolidation batch
{common}Type=oneshot
ExecStart={worker} --local --source {source} --allow-model-call --limit {batch_limit}
TimeoutStartSec=600
Restart=no
'''
        units['ultrabrain-personal-worker.timer'] = f'''[Unit]
Description=Ultrabrain explicitly authorized personal consolidation schedule
PartOf=ultrabrain-personal.target

[Timer]
OnActiveSec={interval}s
OnUnitInactiveSec={interval}s
AccuracySec=1s
Unit=ultrabrain-personal-worker.service
Persistent=false
'''
        wanted.append('ultrabrain-personal-worker.timer')
    units['ultrabrain-personal.target'] = f'''[Unit]
Description=Ultrabrain personal owner services
Requires=ultrabrain-postgres.service
After=ultrabrain-postgres.service
Wants={' '.join(wanted)}

[Install]
WantedBy=default.target
'''
    return units


def unit_directory(path, create=False):
    """Resolve from / with no-follow descriptors; never traverse a linked parent."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts: raise ValueError('Absolute unambiguous unit directory required')
    quote(path)
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            if create:
                try: os.mkdir(part, mode=0o700, dir_fd=fd); os.fsync(fd)
                except FileExistsError: pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        st = os.fstat(fd)
        if st.st_uid != os.geteuid() or st.st_mode & 0o022: raise ValueError('Unsafe unit directory')
        return fd
    except BaseException:
        os.close(fd); raise


def read_unit(fd, name):
    try: leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError: return None
    try:
        st = os.fstat(leaf)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.geteuid() or st.st_mode & 0o022 or st.st_size > 65536:
            raise ValueError('Unsafe unit file')
        data = bytearray()
        while len(data) <= 65536:
            chunk = os.read(leaf, min(8192, 65537-len(data)))
            if not chunk: break
            data.extend(chunk)
        end = os.fstat(leaf); current = os.stat(name, dir_fd=fd, follow_symlinks=False)
        shape = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
        if len(data) != st.st_size or shape(st) != shape(end) or shape(st) != shape(current):
            raise ValueError('Unit changed while reading')
        return bytes(data)
    finally: os.close(leaf)


def new_unit(fd, name, data):
    leaf = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    with os.fdopen(leaf, 'wb') as out:
        out.write(data); out.flush(); os.fsync(out.fileno())


def write_units(target, units, replace=False):
    """Cooperative local install, backups before replacement. Not multi-file atomic."""
    import fcntl
    import re
    if not units or any(not re.fullmatch(r'ultrabrain-[a-z-]+\.(service|timer|target)', name) for name in units):
        raise ValueError('Unexpected unit name')
    if any(not isinstance(text, str) or len(text.encode()) > 65536 for text in units.values()):
        raise ValueError('Oversized unit')
    target = Path(os.path.abspath(target))
    fd = unit_directory(target, create=True); lock = None
    def recheck():
        other = unit_directory(target)
        try:
            a,b = os.fstat(fd),os.fstat(other)
            if (a.st_dev,a.st_ino) != (b.st_dev,b.st_ino): raise ValueError('Unit directory replaced')
        finally: os.close(other)
    try:
        lock = os.open('.ultrabrain-service-install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
        st = os.fstat(lock)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise ValueError('Unsafe installation lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old = {name:read_unit(fd,name) for name in units}
        changed = [name for name in units if old[name] != units[name].encode()]
        if not replace and any(old[name] is not None for name in changed):
            raise ValueError('Existing units differ; review before --replace')
        backup = None
        if any(old[name] is not None for name in changed):
            backup = '.ultrabrain-before-' + secrets.token_hex(12)
            os.mkdir(backup, mode=0o700, dir_fd=fd)
            backup_fd = os.open(backup, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                for name in changed:
                    if old[name] is not None: new_unit(backup_fd, name, old[name])
                manifest = {'format':1,'before':{name:hashlib.sha256(old[name]).hexdigest() if old[name] is not None else None for name in changed},
                    'after':{name:hashlib.sha256(units[name].encode()).hexdigest() for name in changed},
                    'note':'Old unit bytes only. Check actual files before manual rollback; not an application data backup.'}
                new_unit(backup_fd,'manifest.json',(json.dumps(manifest,indent=2)+'\n').encode()); os.fsync(backup_fd)
            finally: os.close(backup_fd)
            os.fsync(fd)
        for name in changed:
            recheck()
            if read_unit(fd,name) != old[name]: raise ValueError('Concurrent unit change')
            temp = '.ultrabrain-unit-' + secrets.token_hex(12)
            try:
                new_unit(fd,temp,units[name].encode())
                recheck()
                if read_unit(fd,name) != old[name]: raise ValueError('Concurrent unit change')
                if old[name] is None:
                    os.link(temp,name,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
                else: os.replace(temp,name,src_dir_fd=fd,dst_dir_fd=fd)
            finally:
                try: os.unlink(temp,dir_fd=fd)
                except FileNotFoundError: pass
        os.fsync(fd); recheck()
        return {'changed':changed,'backup_directory':str(target/backup) if backup else None}
    finally:
        if lock is not None: os.close(lock)
        os.close(fd)


PERSONAL_COMPONENTS = ('ultrabrain-personal.target', 'ultrabrain-personal-console.service',
    'ultrabrain-personal-mcp.service', 'ultrabrain-personal-worker.service', 'ultrabrain-personal-worker.timer')


def require_inactive(names):
    """Refuse ambiguous manager errors, active children and in-progress activation."""
    for name in names:
        result = subprocess.run(['systemctl','--user','is-active',name],
            capture_output=True,text=True,timeout=10)
        if result.returncode not in (3,4) or result.stdout.strip() not in ('inactive','failed','unknown'):
            raise ValueError('Stop affected services and verify the user manager before reconfiguration')


def reconfiguration_guard(target, units):
    # A child might have been started manually without its target. Do not replace
    # its authority while it is running, even when the target itself is inactive.
    require_inactive(PERSONAL_COMPONENTS)
    try: fd = unit_directory(target)
    except FileNotFoundError: return
    try: old = read_unit(fd,'ultrabrain-postgres.service')
    finally: os.close(fd)
    if old is not None and old != units['ultrabrain-postgres.service'].encode():
        require_inactive(('ultrabrain-postgres.service',))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,help='Render into a review directory only; no service changes')
    parser.add_argument('--enable',action='store_true',help='Explicitly enable/start the selected user services')
    parser.add_argument('--replace',action='store_true',help='Replace differing units after preserving their old bytes')
    parser.add_argument('--port',type=int,default=3131)
    parser.add_argument('--public-url')
    parser.add_argument('--profile',choices=['compatibility','governed'],default='compatibility')
    parser.add_argument('--personal',action='store_true',help='Personal target and console, no HTTP or model calls by default')
    parser.add_argument('--source',default='default')
    parser.add_argument('--console-port',type=int,default=3132)
    parser.add_argument('--with-http-mcp',action='store_true')
    parser.add_argument('--consolidation-interval',type=int)
    parser.add_argument('--allow-model-call',action='store_true')
    parser.add_argument('--batch-limit',type=int,default=1)
    args=parser.parse_args()
    if args.output and args.enable: parser.error('--output cannot be combined with --enable')
    if args.personal and (args.profile!='compatibility' or args.public_url): parser.error('Personal services cannot enable enterprise/public URL profiles')
    if not args.personal and (args.source!='default' or args.console_port!=3132 or args.with_http_mcp or args.consolidation_interval is not None or args.allow_model_call or args.batch_limit!=1):
        parser.error('Personal options require --personal')
    if os.geteuid()==0: parser.error('Run as the ordinary account that bootstrapped Ultrabrain')
    home=Path(os.path.abspath(os.environ.get('ULTRABRAIN_HOME',Path.home()/'.local/share/ultrabrain')))
    if not (home/'postgres/runtime.json').is_file(): parser.error('Bootstrap the managed database first')
    bun=shutil.which('bun'); python=shutil.which('python3')
    if not bun or not python: parser.error('bun and python3 must be available in trusted PATH')
    target=args.output or Path.home()/'.config/systemd/user'
    try:
        if args.personal:
            # Metadata only; source existence/model configuration are rechecked by services.
            import importlib.util
            spec=importlib.util.spec_from_file_location('ultrabrain_service_preflight',ROOT/'scripts/preflight.py')
            inspector=importlib.util.module_from_spec(spec);spec.loader.exec_module(inspector)
            with inspector.PrivateHome(home) as state:
                state.metadata('postgres/runtime.json')
                try: state.metadata('service.env')
                except FileNotFoundError: pass
                state.unchanged()
        if args.personal:
            units=render_personal(ROOT,home,Path(bun).resolve(),Path(python).resolve(),source=args.source,
                console_port=args.console_port,http_port=args.port if args.with_http_mcp else None,
                interval=args.consolidation_interval,allow_model_call=args.allow_model_call,batch_limit=args.batch_limit)
        else: units=render(ROOT,home,Path(bun).resolve(),Path(python).resolve(),args.port,args.public_url,args.profile)
        # Reconfiguration is separate from activation: no partly reconfigured live target.
        if args.personal and args.replace and not args.output:
            reconfiguration_guard(target,units)
        result=write_units(target,units,args.replace)
        print(json.dumps({'units':list(units),**result,'services_started':False,'model_calls':0}))
        if args.enable:
            subprocess.run(['systemctl','--user','daemon-reload'],check=True,timeout=30)
            names=['ultrabrain-personal.target'] if args.personal else ['ultrabrain-postgres.service','ultrabrain-mcp.service']
            subprocess.run(['systemctl','--user','enable','--now',*names],check=True,timeout=180)
            print('Service activation requested. Verify each component and authenticated connectivity; boot without login needs administrator-approved lingering.')
    except Exception:
        # Unit paths, prior content and provider environment may contain private data.
        print(json.dumps({'ok':False,'error':'service_configuration_failed','note':'Existing backup/partial files are retained; do not assume any requested service started.'}))
        raise SystemExit(1)
if __name__=='__main__': main()
