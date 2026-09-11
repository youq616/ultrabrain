#!/usr/bin/env python3
"""Generate user-systemd units for the managed database and loopback MCP server."""
import argparse
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]

def quote(value):
    value = str(value)
    if any(ord(c) < 32 for c in value): raise ValueError('Control characters are forbidden in unit paths')
    # Unit specifiers and ExecStart environment expansion are separate from shell quoting.
    return '"' + value.replace('\\','\\\\').replace('"','\\"').replace('%','%%') + '"'

def literal_path(value):
    value=str(value)
    if any(ord(c)<32 for c in value): raise ValueError('Control characters are forbidden in unit paths')
    return value.replace('%','%%')

def exec_quote(value):
    return quote(value).replace('$','$$')

def render(root, home, bun, python, port=3131, public_url=None):
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
    extra = ' --public-url '+exec_quote(public_url) if public_url else ''
    mcp = f'''[Unit]
Description=Ultrabrain authenticated MCP on loopback
Requires=ultrabrain-postgres.service
After=ultrabrain-postgres.service

[Service]
Type=simple
{common}EnvironmentFile=-{literal_path(home / 'service.env')}
ExecStartPre={command} migrate
ExecStart={command} mcp --http --bind 127.0.0.1 --port {port} --suppress-bootstrap-token{extra}
Restart=on-failure
RestartSec=5
TimeoutStartSec=180
TimeoutStopSec=30

[Install]
WantedBy=default.target
'''
    return {'ultrabrain-postgres.service':database,'ultrabrain-mcp.service':mcp}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,help='Only render files into this directory; do not enable services')
    parser.add_argument('--enable',action='store_true',help='Reload and enable generated user services now')
    parser.add_argument('--replace',action='store_true',help='Explicitly replace differing existing unit files')
    parser.add_argument('--port',type=int,default=3131)
    parser.add_argument('--public-url')
    args=parser.parse_args()
    if args.output and args.enable: parser.error('--output cannot be combined with --enable')
    if os.geteuid()==0: parser.error('Run as the same unprivileged account that bootstrapped Ultrabrain')
    home=Path(os.environ.get('ULTRABRAIN_HOME',Path.home()/'.local/share/ultrabrain')).resolve()
    if not (home/'postgres/runtime.json').is_file(): parser.error('Bootstrap the managed database before installing services')
    bun=shutil.which('bun'); python=shutil.which('python3')
    if not bun or not python: parser.error('bun and python3 must be available in PATH')
    target=args.output or Path.home()/'.config/systemd/user'
    units=render(ROOT,home,Path(bun).resolve(),Path(python).resolve(),args.port,args.public_url)
    target.mkdir(parents=True,exist_ok=True)
    # Check every target before writing anything. No silent overwrite of operator customization.
    for name,content in units.items():
        path=target/name
        if path.is_symlink(): parser.error('Refusing a symlinked unit file')
        if path.exists() and path.read_text()!=content and not args.replace:
            parser.error('Existing units differ; review changes before using --replace')
    for name,content in units.items():
        (target/name).write_text(content)
        print(target/name)
    if args.enable:
        subprocess.run(['systemctl','--user','daemon-reload'],check=True)
        subprocess.run(['systemctl','--user','enable','--now','ultrabrain-postgres.service','ultrabrain-mcp.service'],check=True)
        print('User services enabled. For boot without login, the host administrator must enable lingering for this account.')
    else:
        print('Units written only; no service started. Review before enabling. MCP binds exclusively to 127.0.0.1.')
if __name__=='__main__': main()
