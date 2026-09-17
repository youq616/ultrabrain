#!/usr/bin/env python3
"""Plan/apply/rollback ONE client configuration. No installation, network call, or service restart."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import sys
import tomllib

CLIENTS = ('codex','claude-code','opencode','zcode','claude-hooks','claude-capture-hooks','claude-task-hooks')
MAX_FILE = 2 * 1024 * 1024
class ConfigError(Exception):
    pass

def check(condition, code):
    if not condition:
        raise ConfigError(code)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def pairs(items):
    out={}
    for k,v in items:
        check(k not in out, 'duplicate_json_key'); out[k]=v
    return out

def json_load(data):
    return json.loads(data.decode('utf-8'), object_pairs_hook=pairs)

def safe_path(path):
    p=Path(os.path.abspath(path))
    for part in [p,*p.parents]:
        if part.exists() or part.is_symlink():
            st=part.lstat()
            check(not stat.S_ISLNK(st.st_mode) and not (getattr(st,'st_file_attributes',0) & getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0x400)), 'symlink_or_junction_refused')
    return p

def read_file(path):
    p=safe_path(path)
    if not p.exists():
        return None
    st=p.lstat();check(stat.S_ISREG(st.st_mode) and st.st_size<=MAX_FILE,'invalid_config_file')
    if os.name!='nt':
        check(st.st_uid==os.getuid() and not st.st_mode & 0o022,'unsafe_config_owner_or_mode')
    with p.open('rb') as f:
        data=f.read(MAX_FILE+1)
    check(len(data)<=MAX_FILE,'config_too_large');return data

def write_new(path,data):
    # Exclusive create; never follow an existing symlink or replace a backup.
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    with os.fdopen(fd,'wb') as f:
        f.write(data);f.flush();os.fsync(f.fileno())

def sync_dir(path):
    if os.name!='nt':
        fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)

def replace_config(target,data,expected):
    current=read_file(target)
    check(('absent' if current is None else digest(current))==expected,'concurrent_config_change')
    temp=target.with_name(target.name+'.ultrabrain-tmp-'+secrets.token_hex(6))
    write_new(temp,data)
    try:
        check(read_file(target)==current,'concurrent_config_change')
        os.replace(temp,target);sync_dir(target.parent)
    finally:
        temp.unlink(missing_ok=True)

def command_spec(node,cli,profile):
    for value in (node,cli,profile):
        check(isinstance(value,str) and value and not re.search(r'[\x00-\x1f\x7f]',value),'invalid_command_path')
    check(Path(cli).is_absolute() and Path(profile).is_absolute(),'absolute_cli_and_profile_required')
    return [node,cli,'mcp','--profile',profile]

def patch(client,old,command,capture_scopes=(),task_scopes=()):
    if client=='codex':
        text='' if old is None else old.decode('utf-8');parsed=tomllib.loads(text)
        servers=parsed.get('mcp_servers',{});check(isinstance(servers,dict),'invalid_mcp_table')
        entry={'command':command[0],'args':command[1:],'startup_timeout_sec':30,'tool_timeout_sec':30}
        if 'ultrabrain' in servers:
            check(servers['ultrabrain']==entry,'existing_ultrabrain_conflict');return old
        block='\n[mcp_servers.ultrabrain]\n'+'\n'.join(k+' = '+json.dumps(v,ensure_ascii=False) for k,v in entry.items())+'\n'
        out=(text+block).encode('utf-8');check(tomllib.loads(out.decode())['mcp_servers']['ultrabrain']==entry,'toml_validation_failed');return out
    data={} if old is None else json_load(old);check(isinstance(data,dict),'object_config_required')
    if client in ('claude-hooks','claude-capture-hooks','claude-task-hooks'):
        # Paths are command data quoted for Claude command hooks' POSIX/Git-Bash shell.
        check(data.get('disableAllHooks') is not True,'hooks_disabled')
        action='claude-capture-hook' if client=='claude-capture-hooks' else 'claude-hook'
        events=('SessionStart','UserPromptSubmit') if client=='claude-hooks' else tuple(e for scope,e in [('claude-user','UserPromptSubmit'),('claude-assistant','Stop')] if scope in capture_scopes)
        if client=='claude-task-hooks':
            check(task_scopes==['claude-user'],'explicit_automatic_task_scope_required')
            action='claude-task-hook';events=('UserPromptSubmit',)
        check(bool(events),'explicit_automatic_capture_scopes_required')
        hook_cmd=shlex.join([command[0].replace('\\','/'),command[1].replace('\\','/'),action,'--profile',command[-1].replace('\\','/')])
        hooks=data.setdefault('hooks',{});check(isinstance(hooks,dict),'invalid_hooks')
        for event in events:
            group={'matcher':'','hooks':[{'type':'command','command':hook_cmd,'timeout':30}]}
            entries=hooks.setdefault(event,[]);check(isinstance(entries,list),'invalid_hook_list')
            if group not in entries: entries.append(group)
    else:
        key='mcpServers' if client=='claude-code' else 'mcp'
        holder=data.setdefault(key,{});check(isinstance(holder,dict),'invalid_mcp_object')
        if client=='zcode':
            holder=holder.setdefault('servers',{});check(isinstance(holder,dict),'invalid_mcp_servers')
        entry={'type':'local','command':command,'enabled':True,'timeout':30000} if client=='opencode' else {'command':command[0],'args':command[1:]}
        if client=='claude-code':entry['type']='stdio'
        if 'ultrabrain'in holder:check(holder['ultrabrain']==entry,'existing_ultrabrain_conflict')
        holder['ultrabrain']=entry
    out=(json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
    # No-op preserves original comments/formatting where input is already semantically equal.
    if old is not None and json_load(old)==data:return old
    return out

def apply(target,old,new,expected):
    check(target.parent.is_dir(),'target_parent_missing')
    current='absent' if old is None else digest(old);check(expected==current,'expected_sha_mismatch')
    if old==new:return {'changed':False,'sha256':current}
    suffix=secrets.token_hex(8);base=target.name+'.ultrabrain-'+suffix
    backup=target.with_name(base+'.before');receipt=target.with_name(base+'.receipt.json')
    if old is not None:write_new(backup,old)
    # Write rollback evidence BEFORE replacing the target, so a crash cannot lose the old bytes.
    record={'format':1,'target':str(target),'before_sha256':current,'after_sha256':digest(new),'backup':backup.name if old is not None else None}
    write_new(receipt,(json.dumps(record,indent=2)+'\n').encode());sync_dir(target.parent)
    replace_config(target,new,current)
    return {'changed':True,'sha256':digest(new),'rollback_receipt':str(receipt),'backup_created':old is not None}

def rollback(target,receipt_path):
    receipt=safe_path(receipt_path);check(receipt.parent==target.parent,'receipt_must_be_adjacent')
    r=json_load(read_file(receipt));check(r.get('format')==1 and r.get('target')==str(target),'receipt_target_mismatch')
    current=read_file(target);check(current is not None and digest(current)==r['after_sha256'],'rollback_target_changed')
    if r['before_sha256']=='absent':
        check(r['backup'] is None,'invalid_receipt');target.unlink();sync_dir(target.parent)
    else:
        check(isinstance(r['backup'],str) and Path(r['backup']).name==r['backup'],'invalid_backup_path')
        old=read_file(target.with_name(r['backup']));check(old is not None and digest(old)==r['before_sha256'],'backup_hash_mismatch')
        replace_config(target,old,r['after_sha256'])
    return {'rolled_back':True,'target':str(target),'restored_sha256':r['before_sha256']}

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--client',choices=CLIENTS);p.add_argument('--target',required=True)
    p.add_argument('--profile');p.add_argument('--cli');p.add_argument('--node',default='node');p.add_argument('--apply',action='store_true');p.add_argument('--expected-sha');p.add_argument('--rollback')
    a=p.parse_args(argv);target=safe_path(a.target)
    lock=target.with_name(target.name+'.ultrabrain-config.lock')
    try:
        if a.rollback:
            check(not a.apply and not a.client,'rollback_arguments_conflict');write_new(lock,b'local configuration transaction\n')
            try:result=rollback(target,a.rollback)
            finally:lock.unlink(missing_ok=True)
        else:
            check(a.client and a.cli and a.profile,'client_cli_profile_required')
            profile_path=safe_path(a.profile);profile=json_load(read_file(profile_path));check(profile.get('format')==1,'invalid_profile')
            # Validate through the actual client probe separately before use; no secrets or commands executed here.
            cli_path=safe_path(a.cli);check(cli_path.is_file(),'client_cli_missing')
            if a.client=='claude-capture-hooks':
                check(profile.get('allow_capture') is True and profile.get('workspace') and profile.get('expected_instance') and profile.get('expected_actor') and profile.get('outbox_directory'),'automatic_capture_profile_required')
            if a.client=='claude-task-hooks':
                check(profile.get('allow_task_context') is True and profile.get('automatic_task_context')==['claude-user']
                      and Path(profile.get('workspace','')).is_absolute()
                      and bool(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',profile.get('expected_instance','')))
                      and bool(re.fullmatch(r'[a-f0-9]{64}',profile.get('expected_actor',''))),'task_context_profile_required')
            command=command_spec(a.node,str(cli_path),str(profile_path));old=read_file(target);new=patch(a.client,old,command,profile.get('automatic_capture',[]),profile.get('automatic_task_context',[]))
            result={'client':a.client,'target':str(target),'changed':old!=new,'before_sha256':'absent' if old is None else digest(old),'after_sha256':digest(new),'mode':'plan','contains_memory':False}
            if a.apply:
                write_new(lock,b'local configuration transaction\n')
                try:result.update(apply(target,old,new,a.expected_sha));result['mode']='applied'
                finally:lock.unlink(missing_ok=True)
        print(json.dumps(result,ensure_ascii=False,indent=2));return 0
    except Exception as e:
        # Config text can include unrelated credentials. Never print raw parser exceptions.
        print(json.dumps({'ok':False,'error':str(e) if isinstance(e,ConfigError) else 'config_operation_failed'}));return 1
if __name__=='__main__':sys.exit(main())
