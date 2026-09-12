#!/usr/bin/env python3
"""Explicitly configure semantic summaries in the actual native config file. No API call."""
import argparse
import fcntl
import json
import os
import re
import secrets
from pathlib import Path
from postgres import HOME, private_write

def configure(path, *, model=None, revision=None, disabled=False, from_chat=False):
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o077:
        raise RuntimeError('Run db init first; native config must be an owner-only regular file')
    original = path.read_text()
    value = json.loads(original)
    if disabled:
        value['ultrabrain_semantics'] = {'enabled': False}
    else:
        if from_chat:
            model = value.get('chat_model')
        if not isinstance(model,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+:[A-Za-z0-9_./:@+\-]{1,200}',model) or '://' in model:
            raise RuntimeError('Provide an explicit provider:model or an existing file-configured chat_model')
        if not isinstance(revision,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',revision):
            raise RuntimeError('Provide a profile revision; change it when model aliases or endpoints change')
        value['ultrabrain_semantics'] = {'enabled': True, 'model': model, 'revision': revision,
            'chunk_bytes':8192, 'max_chunks':8, 'ttl_seconds':86400, 'timeout_ms':120000}
    # Helpers serialize updates; stop other config writers before changing settings.
    if path.read_text() != original:
        raise RuntimeError('Configuration changed concurrently; retry without overwriting it')
    backup = path.with_name('config.before-summary-' + secrets.token_hex(6) + '.json')
    private_write(backup, original)
    private_write(path, json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    return {'enabled':not disabled,'model':None if disabled else model,
        'revision':None if disabled else revision,'model_calls':0,'private_backup_created':True,
        'next_step':'Restart MCP after provider changes. Generation additionally requires allow_model_call:true.'}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    choice=parser.add_mutually_exclusive_group(required=True)
    choice.add_argument('--model');choice.add_argument('--from-chat-model',action='store_true');choice.add_argument('--disable',action='store_true')
    parser.add_argument('--revision')
    args=parser.parse_args()
    if os.geteuid()==0: parser.error('Run as the existing unprivileged Ultrabrain service account')
    os.umask(0o077)
    path=HOME/'gbrain/.gbrain/config.json'
    with path.with_name('.summary-config.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        print(json.dumps(configure(path,model=args.model,revision=args.revision,
            disabled=args.disable,from_chat=args.from_chat_model),ensure_ascii=False,indent=2))
if __name__=='__main__':
    try:main()
    except (RuntimeError,OSError,ValueError):
        raise SystemExit('Summary configuration failed; check private native config and explicit model/revision. No model was called.')
