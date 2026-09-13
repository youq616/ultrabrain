#!/usr/bin/env python3
"""Enable only personal consolidation using an existing native provider. No model call."""
import argparse
import fcntl
import json
import os
import re
import secrets
from postgres import HOME, private_write


def configure(path, *, model=None, revision=None, from_chat=False, disable=False):
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o077:
        raise RuntimeError('Private native config required')
    original = path.read_text()
    data = json.loads(original)
    if disable:
        data['ultrabrain_personal_consolidation'] = {'enabled': False}
    else:
        if from_chat:
            model = data.get('chat_model')
        if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+:[A-Za-z0-9_./:@+\-]{1,200}', model) or '://' in model:
            raise RuntimeError('Explicit provider:model required')
        if not isinstance(revision, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', revision):
            raise RuntimeError('Explicit profile revision required')
        data['ultrabrain_personal_consolidation'] = {'enabled': True, 'model': model, 'revision': revision, 'timeout_ms': 60000}
    if path.read_text() != original:
        raise RuntimeError('Concurrent config change; retry without overwriting')
    private_write(path.with_name('config.before-personal-' + secrets.token_hex(6) + '.json'), original)
    private_write(path, json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    return {'enabled': not disable, 'model_calls': 0, 'private_backup_created': True,
            'scope': 'personal consolidation only; provider credentials and summaries unchanged',
            'notice': 'Stop other config writers during edits. Restart MCP after provider changes. A worker additionally needs explicit model permission.'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    choice = p.add_mutually_exclusive_group(required=True)
    choice.add_argument('--model')
    choice.add_argument('--from-chat-model', action='store_true')
    choice.add_argument('--disable', action='store_true')
    p.add_argument('--revision')
    args = p.parse_args()
    if os.geteuid() == 0:
        p.error('Use the existing unprivileged service account')
    os.umask(0o077)
    path = HOME / 'gbrain/.gbrain/config.json'
    with path.with_name('.personal-config.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        print(json.dumps(configure(path, model=args.model, revision=args.revision,
                                   from_chat=args.from_chat_model, disable=args.disable)))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError):
        raise SystemExit('Personal configuration failed; check private file and explicit profile. No model was called.')
