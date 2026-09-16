#!/usr/bin/env python3
"""Render and verify inactive user-systemd units. Never link, enable or start services.

The console is loopback-only. Periodic owner consolidation requires TWO explicit
flags; it does not expand capture consent or retry failed jobs. Existing operator
units are never overwritten. Output is an exclusive, hash-bound private bundle.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ub_service_preflight', ROOT/'scripts/preflight.py')
pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pf)

class ServiceError(Exception):
    pass

def need(ok, code):
    if not ok:
        raise ServiceError(code)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def encode(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True, indent=2)+'\n').encode()

def path_value(value):
    p = Path(value)
    need(p.is_absolute() and '..' not in p.parts and '\\' not in str(p) and ':' not in str(p) and str(p)==str(p).strip() and
         not any(ord(c)<32 or ord(c)==127 for c in str(p)), 'invalid_absolute_path')
    return str(p)

def quote(value, command=False):
    # systemd unit specifiers and Exec* environment substitutions are not shell quoting.
    value = str(value)
    need(not any(ord(c)<32 or ord(c)==127 for c in value), 'invalid_unit_value')
    value = value.replace('\\','\\\\').replace('"','\\"').replace('%','%%')
    if command:
        value = value.replace('$','$$')
    return '"'+value+'"'

def command(*args):
    return ' '.join(quote(x, True) for x in args)

def render_units(*, root, home, bun, python, source, name='ultrabrain-personal',
                 database_unit='ultrabrain-postgres.service', port=3132,
                 with_consolidation=False, allow_model_call=False, interval=300, limit=1):
    root, home, bun, python = map(path_value, (root, home, bun, python))
    need(isinstance(source,str) and re.fullmatch(r'[a-z0-9-]{1,32}',source), 'invalid_source')
    need(isinstance(name,str) and re.fullmatch(r'[a-z][a-z0-9-]{0,47}',name), 'invalid_service_name')
    need(isinstance(database_unit,str) and re.fullmatch(r'[a-z][a-z0-9-]{0,63}\.service',database_unit), 'invalid_database_unit')
    need(type(port) is int and 1024<=port<=65535, 'invalid_console_port')
    need(type(interval) is int and 30<=interval<=86400, 'invalid_interval')
    need(type(limit) is int and 1<=limit<=4, 'invalid_batch_limit')
    need(type(with_consolidation) is bool and type(allow_model_call) is bool and
         with_consolidation == allow_model_call, 'explicit_model_schedule_consent_required')
    names = [name+'-console.service', name+'-worker.service', name+'-worker.timer']
    need(database_unit not in names, 'database_unit_cycle')
    dependency = f'BindsTo={database_unit}\nAfter={database_unit}\nPartOf={database_unit}\n'
    common = f'''WorkingDirectory={root.replace("%","%%")}
Environment={quote('PATH='+str(Path(bun).parent)+':'+str(Path(python).parent)+':/usr/local/bin:/usr/bin:/bin')}
Environment={quote('ULTRABRAIN_HOME='+home)}
Environment={quote('GBRAIN_SOURCE='+source)}
Environment=ULTRABRAIN_MCP_PROFILE=compatibility
Environment=GBRAIN_SELF_UPGRADE_MODE=off
Environment=GBRAIN_SWEEP=0
UnsetEnvironment=DATABASE_URL GBRAIN_DATABASE_URL GBRAIN_HOME NODE_OPTIONS BUN_OPTIONS
UMask=0077
NoNewPrivileges=true
PrivateUsers=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths={quote(home)}
RestrictSUIDSGID=true
KillMode=control-group
TimeoutStopSec=30
ExecStartPre={command(python,'-B',root+'/scripts/preflight.py','--mode','runtime','--home',home)}
'''
    console = f'''# Generated inactive bundle. Link/enable only after reviewing its pinned manifest.
[Unit]
Description=Ultrabrain private personal console
{dependency}StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
{common}ExecStart={command(bun,root+'/src/cli.mjs','personal-ui','--source',source,'--port',str(port))}
Restart=on-failure
RestartSec=5
TimeoutStartSec=60

[Install]
WantedBy=default.target
'''
    units = {names[0]:console}
    if with_consolidation:
        units[names[1]] = f'''# Explicit owner-only model processing; no capture, failed-job retry or automatic approval.
[Unit]
Description=Ultrabrain bounded personal consolidation batch
{dependency}
[Service]
Type=oneshot
{common}ExecStart={command(bun,root+'/scripts/personal-worker.mjs','--local','--source',source,'--limit',str(limit),'--allow-model-call')}
RemainAfterExit=no
Restart=no
TimeoutStartSec=600
'''
        units[names[2]] = f'''# No missed-run catch-up. One batch at a time, interval starts after deactivation.
[Unit]
Description=Ultrabrain explicitly authorized personal consolidation timer
{dependency}
[Timer]
OnActiveSec=30s
OnUnitInactiveSec={interval}s
AccuracySec=1s
Persistent=false
Unit={names[1]}

[Install]
WantedBy=timers.target
'''
    return units

def bundle_paths(directory):
    p = Path(path_value(directory))
    fd, missing = pf.absolute_directory(p)
    try:
        need(not missing, 'bundle_directory_missing')
        pf.is_private(os.fstat(fd), 'directory')
    finally:
        os.close(fd)
    return p

def safe_read(view, name):
    return view.read(name, 65536)

def verify(directory, expected):
    need(isinstance(expected,str) and re.fullmatch(r'[a-f0-9]{64}',expected), 'expected_manifest_sha_required')
    path = bundle_paths(directory)
    with pf.PrivateHome(path) as view:
        need(set(os.listdir(view.fd)) >= {'manifest.json'}, 'bundle_incomplete')
        raw = safe_read(view, 'manifest.json')
        need(digest(raw)==expected, 'manifest_hash_mismatch')
        manifest = pf.object_json(raw)
        need(manifest.get('format')==1 and manifest.get('kind')=='personal-service-units', 'invalid_manifest')
        settings = manifest.get('settings')
        need(isinstance(settings,dict), 'invalid_manifest')
        try:
            regenerated = render_units(**settings)
        except (TypeError, ValueError):
            raise ServiceError('invalid_manifest') from None
        need(set(manifest)=={'format','kind','settings','files','model_schedule_authorized','services_started','capture_enabled','credentials_copied'}
             and manifest.get('model_schedule_authorized') is settings.get('with_consolidation',False)
             and all(manifest.get(k) is False for k in ('services_started','capture_enabled','credentials_copied')), 'invalid_manifest')
        files = manifest.get('files')
        need(isinstance(files,dict) and set(files)==set(regenerated), 'invalid_inventory')
        need(set(os.listdir(view.fd))==set(files)|{'manifest.json'}, 'unexpected_bundle_files')
        for name, content in regenerated.items():
            raw = safe_read(view,name)
            need(raw==content.encode() and files[name]==digest(raw), 'unit_hash_mismatch')
        view.unchanged()
    return {'verified':True,'manifest_sha256':expected,'unit_names':sorted(files),
            'services_started':False,'models_called':False,'unit_syntax_checked':False}

def generate(output, settings, *, precheck=pf.preflight):
    # Preflight is offline. It does not grant production readiness or reserve ports/resources.
    settings = dict(settings)
    units = render_units(**settings)
    report = precheck('runtime', Path(settings['home']), root=Path(settings['root']))
    need(report.get('ok') is True, 'runtime_preflight_failed')
    out = Path(path_value(output))
    home, root = Path(settings['home']), Path(settings['root'])
    for other in (home,root):
        need(out!=other and other not in out.parents and out not in other.parents, 'bundle_overlaps_installation')
    parent = bundle_paths(out.parent)
    # A private parent and held descriptor prevent redirecting output through a path link.
    with pf.PrivateHome(parent) as parent_view:
        os.mkdir(out.name, mode=0o700, dir_fd=parent_view.fd)
        fd = os.open(out.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent_view.fd)
        try:
            def write(name, raw):
                leaf=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
                with os.fdopen(leaf,'wb') as f:
                    f.write(raw);f.flush();os.fsync(f.fileno())
            write('INCOMPLETE',b'Incomplete: never install these files.\n')
            for name,content in units.items():write(name,content.encode())
            manifest={'format':1,'kind':'personal-service-units','settings':settings,
                      'files':{n:digest(c.encode()) for n,c in units.items()},
                      'model_schedule_authorized':settings.get('with_consolidation',False),
                      'services_started':False,'capture_enabled':False,'credentials_copied':False}
            raw=encode(manifest);write('manifest.json',raw)
            os.fsync(fd);parent_view.unchanged()
            # Check the new output directory has not been replaced before removing its marker.
            now=os.stat(out.name,dir_fd=parent_view.fd,follow_symlinks=False)
            opened=os.fstat(fd)
            need((now.st_dev,now.st_ino)==(opened.st_dev,opened.st_ino), 'output_changed')
            os.unlink('INCOMPLETE',dir_fd=fd);os.fsync(fd);os.fsync(parent_view.fd)
        finally:os.close(fd)
    verified=verify(out,digest(raw))
    return {**verified,'generated':True,'preflight_only':True,
            'model_schedule_authorized':settings.get('with_consolidation',False),
            'notice':'No units linked/enabled; no services or model started. Keep the manifest digest separately.'}

class Parser(argparse.ArgumentParser):
    def error(self, _):
        raise ServiceError('invalid_arguments')

def main(argv=None):
    try:
        need(sys.platform=='linux' and os.geteuid()!=0, 'ordinary_linux_service_account_required')
        p=Parser(description=__doc__)
        sub=p.add_subparsers(dest='action',required=True)
        v=sub.add_parser('verify');v.add_argument('--directory',required=True);v.add_argument('--expected-sha',required=True)
        g=sub.add_parser('render');g.add_argument('--output',required=True);g.add_argument('--source',required=True)
        g.add_argument('--name',default='ultrabrain-personal');g.add_argument('--database-unit',default='ultrabrain-postgres.service')
        g.add_argument('--console-port',type=int,default=3132);g.add_argument('--interval',type=int,default=300)
        g.add_argument('--limit',type=int,default=1);g.add_argument('--with-consolidation',action='store_true')
        g.add_argument('--allow-model-call',action='store_true')
        a=p.parse_args(argv)
        if a.action=='verify':result=verify(a.directory,a.expected_sha)
        else:
            bun=pf.dependency_path('bun');need(bun, 'bun_missing')
            home=os.environ.get('ULTRABRAIN_HOME',str(Path.home()/'.local/share/ultrabrain'))
            settings=dict(root=str(ROOT),home=path_value(home),bun=str(Path(bun).resolve()),
                          python=str(Path(sys.executable).resolve()),source=a.source,name=a.name,
                          database_unit=a.database_unit,port=a.console_port,interval=a.interval,limit=a.limit,
                          with_consolidation=a.with_consolidation,allow_model_call=a.allow_model_call)
            result=generate(a.output,settings)
        print(json.dumps({'ok':True,'result':result}));return 0
    except Exception as error:
        code=str(error) if isinstance(error,(ServiceError,pf.PreflightError)) else 'personal_service_generation_failed'
        print(json.dumps({'ok':False,'error':code,'services_started':False,
                          'notice':'No automatic cleanup or overwrite. Incomplete output must not be installed.'}));return 1

if __name__=='__main__':sys.exit(main())
