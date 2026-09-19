#!/usr/bin/env python3
"""Offline, create-only console credential bootstrap for an existing Linux installation.

No service/database/model connection; no source/instance ownership inference. A
partial write is retained and rejected, not silently replaced on the next run.
Directory flock coordinates only instances of this initializer; it is not a lock
on the console, deployment commands, or other same-account operators.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('ultrabrain_init_preflight', ROOT/'scripts/preflight.py')
PREFLIGHT = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PREFLIGHT)
need = PREFLIGHT.require
TOKEN = 'personal-console-token'
NO_ACTIONS = {'services_started': False, 'database_connected': False, 'model_called': False,
              'configuration_changed': False, 'application_ready': False}


def installation(view, root):
    """Verify the same offline managed binding as preflight; do not execute dependencies."""
    need(not view.missing, 'not_installed')
    pins = PREFLIGHT.check_pins(root)
    state = PREFLIGHT.validate_state(PREFLIGHT.object_json(view.read('postgres/state.json')))
    binding = PREFLIGHT.validate_binding(PREFLIGHT.object_json(view.read('postgres/runtime.json')), pins)
    PREFLIGHT.validate_database(PREFLIGHT.object_json(view.read('gbrain/.gbrain/config.json')), state)
    prefix = 'runtime/' + binding
    view.metadata(prefix, directory=True)
    need(view.read(prefix+'/.ultrabrain-build', 256, private=False).strip() ==
         (pins['postgres']['revision']+':'+pins['pgvector']['revision']).encode('ascii'),
         'runtime_build_marker_mismatch')
    for name in PREFLIGHT.RUNTIME_BINARIES:
        need(view.metadata(prefix+'/bin/'+name, private=False).st_mode & stat.S_IXUSR,
             'runtime_binary_not_executable')
    need(view.read('postgres/data/PG_VERSION', 32).strip() ==
         pins['postgres']['version'].split('.')[0].encode('ascii'), 'cluster_major_mismatch')
    view.unchanged()
    return pins


def token_present(view):
    try:
        raw = view.read(TOKEN, 128)
    except FileNotFoundError:
        return False
    # Match the activation planner's raw-byte contract. Trimming would falsely
    # certify whitespace-wrapped credentials that the next stage cannot use.
    need(re.fullmatch(rb'[a-f0-9]{64}\n?', raw) is not None, 'invalid_console_token')
    return True


def require_fresh_setup(view):
    # A lost credential after deployment is a recovery decision, not first run.
    # Even an empty, corrupt or linked history path is not silently adopted.
    for name in ('personal-deployment', 'personal-activation'):
        try:
            os.stat(name, dir_fd=view.fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        need(False, 'token_recovery_required')


def require_platform():
    need(sys.platform == 'linux', 'server_requires_linux')
    need(0 < os.getuid() == os.geteuid(), 'use_ordinary_service_account')
    need(sys.version_info >= (3, 11), 'python_3_11_required')


def initialize(action, home, *, root=ROOT):
    need(action in ('status', 'create-token'), 'invalid_arguments')
    require_platform()
    home, root = Path(home), Path(root)
    need(home.is_absolute() and '..' not in home.parts and
         not any(ord(c) < 32 or ord(c) == 127 for c in str(home)), 'absolute_home_required')
    need(home != root and root not in home.parents and home not in root.parents,
         'home_overlaps_repository')
    with PREFLIGHT.PrivateHome(home) as view:
        need(not view.missing, 'not_installed')
        import fcntl  # Linux-only import after the platform gate.
        try:
            fcntl.flock(view.fd, (fcntl.LOCK_EX if action == 'create-token' else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except BlockingIOError:
            need(False, 'initialization_busy')
        pins = installation(view, root)
        present, created = token_present(view), False
        if not present:
            # Status must distinguish a lost deployed credential from first run,
            # without generating a secret or creating any filesystem state.
            require_fresh_setup(view)
        if not present and action == 'create-token':
            view.unchanged()
            need(PREFLIGHT.check_pins(root) == pins, 'source_lock_changed')
            # Generate before acquiring a pathname. Never truncate, chmod, replace
            # or delete an existing token, including an incomplete prior write.
            raw = secrets.token_hex(32).encode('ascii') + b'\n'
            view.unchanged()
            require_fresh_setup(view)
            try:
                fd = os.open(TOKEN, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=view.fd)
            except FileExistsError:
                # A non-cooperating creator won. Revalidate; no second write.
                present = token_present(view)
                need(present, 'token_changed_during_init')
            else:
                try:
                    os.fchmod(fd, 0o600)  # Only this newly created descriptor.
                    created_stat = os.fstat(fd)
                    PREFLIGHT.is_private(created_stat, 'file')
                    position = 0
                    while position < len(raw):
                        written = os.write(fd, raw[position:])
                        need(written > 0, 'token_write_incomplete')
                        position += written
                    os.fsync(fd)
                    expected = PREFLIGHT.signature(os.fstat(fd))
                finally:
                    os.close(fd)
                os.fsync(view.fd)
                # Confirm that the exact created inode/bytes, not a replacement,
                # occupies the published name. Any error leaves evidence in place.
                need(token_present(view), 'token_changed_during_init')
                need(view.read(TOKEN, 128) == raw, 'token_changed_during_init')
                need(PREFLIGHT.signature(view.metadata(TOKEN)) == expected,
                     'token_changed_during_init')
                created, present = True, True
        need(PREFLIGHT.check_pins(root) == pins, 'source_lock_changed')
        view.unchanged()
        return {'format': 1, 'ok': present, 'action': action,
                'scope': 'offline-console-credential-bootstrap', 'credential_ready': present,
                'token_creation': 'created' if created else 'existing' if present else 'absent',
                'token_file': TOKEN, 'token_value_returned': False,
                'managed_configuration_verified': True, 'instance_identity_verified': False,
                **NO_ACTIONS}


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        need(False, 'invalid_arguments')


def main(argv=None):
    try:
        args = list(sys.argv[1:] if argv is None else argv)
        # Deliberately no abbreviation, equals-form, duplicated option or token value input.
        need(len(args) in (1, 3) and args[0] in ('status', 'create-token') and
             (len(args) == 1 or args[1] == '--home'), 'invalid_arguments')
        parser = Parser(add_help=False, allow_abbrev=False)
        parser.add_argument('action', choices=('status', 'create-token'))
        parser.add_argument('--home')
        parsed = parser.parse_args(args)
        require_platform()
        # dict.get evaluates its default eagerly. An explicit environment home
        # must not depend on an unrelated account-home lookup succeeding.
        home = parsed.home if parsed.home is not None else os.environ.get('ULTRABRAIN_HOME')
        if home is None:
            home = str(Path.home()/'.local/share/ultrabrain')
        result = initialize(parsed.action, home)
        print(json.dumps(result, sort_keys=True))
        return 0 if result['ok'] else 1
    except Exception as error:
        code = PREFLIGHT.failure_code(error)
        if not re.fullmatch('[a-z][a-z_]{0,79}', code):
            code = 'initialization_failed'
        # A create may have reached disk before a later failure; never claim it did not.
        print(json.dumps({'format': 1, 'ok': False, 'error': code,
                          'token_creation': 'not_proven', 'token_value_returned': False,
                          **NO_ACTIONS}, sort_keys=True))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
