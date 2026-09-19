#!/usr/bin/env python3
"""Prepare first-use credentials only after verifying the selected managed database.

No installation, deployment, service start/stop, model or client configuration.
Compose the existing initializer and read-only identity probe; do not weaken their
contracts. Partial preparation is retained, not rolled back or retried blindly.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import importlib.util
import json
import os
from pathlib import Path
import re
import time

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


INIT = load('setup_initializer', 'personal-init.py')
IDENTITY = load('setup_identity', 'personal-identity.py')
PROCESS, PREFLIGHT = IDENTITY.PROCESS, INIT.PREFLIGHT
need = PREFLIGHT.require
SETUP_SECONDS = 20
NO_ACTIONS = {'services_started': False, 'services_stopped': False,
              'configuration_changed': False, 'model_called': False,
              'memory_read': False, 'credentials_returned': False,
              'database_write_requested': False,
              'application_readiness': 'not_checked', 'deployment_readiness': 'not_checked'}


def verified_identity(result, source, expected_instance):
    """Whitelist only verified metadata; never propagate arbitrary component output."""
    need(isinstance(result, dict) and type(result.get('format')) is int and result['format'] == 1
         and result.get('ok') is True and result.get('identity_verified') is True
         and result.get('database_process_binding_verified') is True
         and result.get('source_id') == source
         and result.get('transport') == 'private-unix-socket'
         and result.get('authentication') == 'os-peer-and-scram-sha-256', 'setup_identity_unverified')
    instance = result.get('instance_id')
    need(isinstance(instance, str) and IDENTITY.UUID.fullmatch(instance)
         and instance != '00000000-0000-0000-0000-000000000000', 'invalid_instance_identity')
    need(expected_instance is None or instance == expected_instance, 'setup_instance_mismatch')
    return instance


def setup(action, home, source='default', expected_instance=None, *, root=ROOT):
    need(action in ('check', 'prepare'), 'invalid_arguments')
    IDENTITY.platform_check()
    deadline = time.monotonic() + SETUP_SECONDS

    def within_budget():
        need(time.monotonic() < deadline, 'setup_timeout')

    home, root = IDENTITY.selection(home, source), IDENTITY.FS.absolute(root)
    need(home != root and root not in home.parents and home not in root.parents, 'home_overlaps_repository')
    need(expected_instance is None or isinstance(expected_instance, str)
         and IDENTITY.UUID.fullmatch(expected_instance)
         and expected_instance != '00000000-0000-0000-0000-000000000000', 'invalid_expected_instance')
    # Hold one installation view across both independent components. Its observed
    # config/process/token signatures must survive the complete operation. This is
    # detection under a cooperative maintenance window, not same-UID isolation.
    within_budget()
    with PREFLIGHT.PrivateHome(home) as guard:
        pins = INIT.installation(guard, root)
        present_before = INIT.token_present(guard)
        if not present_before:
            INIT.require_fresh_setup(guard)
        database = PROCESS.database_snapshot(guard, pins)

        def unchanged():
            within_budget()
            guard.unchanged()
            need(PREFLIGHT.check_pins(root) == pins, 'source_lock_changed')
            need(PROCESS.database_snapshot(guard, pins) == database, 'database_changed_during_check')
            within_budget()

        within_budget()
        first = verified_identity(IDENTITY.observe(home, source, root=root, deadline=deadline), source, expected_instance)
        unchanged()  # In particular, a wrong source/instance cannot create a token.
        credential = INIT.initialize('create-token' if action == 'prepare' else 'status', home, root=root)
        within_budget()
        need(isinstance(credential, dict) and type(credential.get('format')) is int and credential['format'] == 1
             and type(credential.get('credential_ready')) is bool
             and credential.get('ok') is credential['credential_ready']
             and credential.get('managed_configuration_verified') is True
             and credential.get('token_creation') in ('created', 'existing', 'absent')
             and credential.get('token_file') == INIT.TOKEN
             and credential.get('token_value_returned') is False, 'setup_credential_unverified')
        need((action == 'prepare' and credential['token_creation'] != 'absent')
             or (action == 'check' and credential['token_creation'] != 'created'), 'setup_credential_unverified')
        present = INIT.token_present(guard)
        need(present == credential['credential_ready']
             and present == (credential['token_creation'] != 'absent'), 'setup_credential_changed')
        unchanged()
        # Reobserve the logical identity after credential preparation. A token may
        # now exist if this fails; do not delete it or report setup as successful.
        final = verified_identity(IDENTITY.observe(home, source, root=root, deadline=deadline), source, first)
        unchanged()
    within_budget()
    return {'format': 1, 'ok': present, 'action': action, 'prepared': present,
            'state': 'prepared' if present else 'credentials_required',
            'scope': 'console credential and live managed database identity; not deployed application readiness',
            'source_id': source, 'instance_id': final, 'identity_verified': True,
            'database_process_binding_verified': True, 'credential_ready': present,
            'token_file': INIT.TOKEN, 'token_creation': credential['token_creation'],
            **NO_ACTIONS}


def main(argv=None):
    try:
        args = list(sys.argv[1:] if argv is None else argv)
        need(len(args) in (1, 3, 5, 7) and args[0] in ('check', 'prepare'), 'invalid_arguments')
        options = {}
        for flag, value in zip(args[1::2], args[2::2]):
            need(flag in ('--home', '--source', '--expected-instance') and flag not in options, 'invalid_arguments')
            options[flag] = value
        IDENTITY.platform_check()
        home = options.get('--home', os.environ.get('ULTRABRAIN_HOME'))
        if home is None:
            home = str(Path.home()/'.local/share/ultrabrain')
        result = setup(args[0], home, options.get('--source', 'default'), options.get('--expected-instance'))
        print(json.dumps(result, sort_keys=True))
        return 0 if result['ok'] else 1
    except Exception as error:
        known = isinstance(error, (PREFLIGHT.PreflightError, IDENTITY.IdentityError,
                                  IDENTITY.PREFLIGHT.PreflightError, IDENTITY.FS.DeployError))
        code = str(error) if known and re.fullmatch('[a-z][a-z_]{0,79}', str(error)) else 'setup_unverified'
        # Even a create followed by a failed final check may have left a token.
        # Do not include a partly verified UUID, token, raw exception or path.
        print(json.dumps({'format': 1, 'ok': False, 'prepared': False, 'error': code,
                          'state': 'unverified', 'identity_verified': False,
                          'token_creation': 'not_proven', **NO_ACTIONS}, sort_keys=True))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
