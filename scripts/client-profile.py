#!/usr/bin/env python3
"""Create a NEW trusted personal-client profile. Never execute SSH or print credentials."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import sys
from urllib.parse import urlsplit

def make_profile(a):
    def check(ok):
        if not ok:raise ValueError('invalid_profile_arguments')
    check(bool(re.fullmatch(r'[a-z0-9-]{1,32}',a.source)))
    if a.project:check(bool(re.fullmatch(r'[A-Za-z0-9_-]{1,96}',a.project)))
    for path in (a.repo,a.home,a.bun):
        if path is not None:check(isinstance(path,str) and not re.search(r'[\x00-\x1f\x7f]',path))
    if a.ssh:
        check(bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',a.ssh)))
        check(all(p and PurePosixPath(p).is_absolute() for p in (a.repo,a.home,a.bun)))
        cmd=shlex.join(['env','ULTRABRAIN_HOME='+a.home,'GBRAIN_SOURCE='+a.source,'GBRAIN_SWEEP=0','ULTRABRAIN_MCP_PROFILE=compatibility',a.bun,str(PurePosixPath(a.repo)/'src/cli.mjs'),'mcp'])
        server={'transport':'stdio','command':'ssh','args':['-T','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=10','-oServerAliveInterval=15','-oServerAliveCountMax=2',a.ssh,'exec '+cmd]}
    elif a.local:
        check(all(p and Path(p).is_absolute() for p in (a.repo,a.home,a.bun)))
        server={'transport':'stdio','command':a.bun,'args':[str(Path(a.repo)/'src/cli.mjs'),'mcp'],
                'env':{'ULTRABRAIN_HOME':a.home,'GBRAIN_SOURCE':a.source,'GBRAIN_SWEEP':'0','ULTRABRAIN_MCP_PROFILE':'compatibility'}}
    else:
        check(not any((a.repo,a.home,a.bun)));u=urlsplit(a.url)
        check(not (u.username or u.password or u.query or u.fragment) and u.hostname and (u.scheme=='https' or u.scheme=='http' and u.hostname in ('127.0.0.1','::1','localhost')))
        check(bool(re.fullmatch(r'[A-Z][A-Z0-9_]{2,95}',a.bearer_env or '')))
        server={'transport':'http','url':a.url,'bearer_env':a.bearer_env}
    result={'allow_documents':getattr(a,'allow_documents',False),'format':1,'source':a.source,'server':server,'allow_capture':a.allow_capture,'budget_bytes':6000,'timeout_ms':10000}
    if a.project:result['project_id']=a.project
    if a.workspace:
        check(Path(a.workspace).is_absolute() and Path(a.workspace).is_dir());result['workspace']=str(Path(a.workspace).resolve())
    if a.expected_instance:
        check(bool(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',a.expected_instance)));result['expected_instance']=a.expected_instance
    if a.expected_actor:
        check(bool(re.fullmatch(r'[a-f0-9]{64}',a.expected_actor)));result['expected_actor']=a.expected_actor
    outbox=getattr(a,'outbox',None); scopes=getattr(a,'automatic_capture',[]) or []
    check(len(scopes)<=4 and len(set(scopes))==len(scopes) and all(x in ('claude-user','claude-assistant','opencode-user','opencode-assistant') for x in scopes))
    if outbox:
        check(Path(outbox).is_absolute() and a.workspace and a.expected_instance and a.expected_actor)
        check(not re.search(r'[\x00-\x1f\x7f]',outbox))
        candidate=Path(outbox).resolve(); workspace=Path(a.workspace).resolve()
        check(candidate!=workspace and workspace not in candidate.parents)
        result['outbox_directory']=str(Path(outbox).absolute())
    if scopes:
        check(a.allow_capture and outbox is not None)
        result['automatic_capture']=scopes
    return result

def main():
    p=argparse.ArgumentParser(description=__doc__);g=p.add_mutually_exclusive_group(required=True)
    g.add_argument('--ssh');g.add_argument('--local',action='store_true');g.add_argument('--url')
    for name in ('repo','home','bun','bearer-env','project','workspace','expected-instance','expected-actor'):p.add_argument('--'+name)
    p.add_argument('--outbox');p.add_argument('--automatic-capture',action='append',choices=['claude-user','claude-assistant','opencode-user','opencode-assistant'],default=[]);p.add_argument('--source',default='default');p.add_argument('--output',required=True);p.add_argument('--allow-documents',action='store_true');p.add_argument('--allow-capture',action='store_true');a=p.parse_args()
    try:
        result=make_profile(a);target=Path(os.path.abspath(a.output))
        for part in [target,*target.parents]:
            if part.exists() or part.is_symlink():
                st=part.lstat()
                if stat.S_ISLNK(st.st_mode) or getattr(st,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0x400):raise ValueError('symlink_refused')
        if not target.parent.is_dir():raise ValueError('create_private_output_directory_first')
        fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
        with os.fdopen(fd,'w',encoding='utf8') as f:json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
        print(json.dumps({'created':str(target),'capture_enabled':a.allow_capture,'network_calls':0,'contains_credentials':False}));return 0
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e) if isinstance(e,ValueError) else 'profile_creation_failed'}));return 1
if __name__=='__main__':sys.exit(main())
