#!/usr/bin/env python3
"""Observe fixed personal user units; never change services, read journals or call models.

Active oneshot database units are not proof of database health. The report is
an observation of the local user's manager, not an application readiness check.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import json
import os
import re
import selectors
import signal
import subprocess
import time

UNITS = ('ultrabrain-postgres.service', 'ultrabrain-personal.target',
         'ultrabrain-personal-console.service', 'ultrabrain-personal-worker.service')
PROPERTIES = ('Id', 'LoadState', 'ActiveState', 'SubState', 'Type', 'Result',
              'ExecMainCode', 'ExecMainStatus', 'NRestarts')
MAX_OUTPUT = 16384
LOAD = {'stub', 'loaded', 'not-found', 'bad-setting', 'error', 'merged', 'masked'}
ACTIVE = {'active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating',
          'maintenance', 'refreshing'}
SUB = {'running', 'exited', 'dead', 'failed', 'active', 'inactive', 'start-pre', 'start',
       'start-post', 'reload', 'reload-signal', 'reload-notify', 'stop', 'stop-watchdog',
       'stop-sigterm', 'stop-sigkill', 'stop-post', 'final-watchdog', 'final-sigterm',
       'final-sigkill', 'auto-restart', 'auto-restart-queued', 'condition', 'cleaning'}
RESULTS = {'success', 'resources', 'timeout', 'exit-code', 'signal', 'core-dump',
           'watchdog', 'start-limit-hit', 'exec-condition', 'oom-kill', 'protocol'}
TYPES = {'simple', 'exec', 'forking', 'oneshot', 'dbus', 'notify', 'notify-reload', 'idle'}
SAFE_ERRORS = {'unsupported_platform', 'ordinary_linux_user_required', 'manager_unavailable',
               'manager_timeout', 'manager_output_limit', 'invalid_manager_response'}

class StatusError(Exception):
    pass

def need(ok, code):
    if not ok:
        raise StatusError(code)

def command():
    return ['/usr/bin/systemctl', '--user', '--no-pager', '--no-ask-password', '--all',
            '--property='+','.join(PROPERTIES), 'show', '--', *UNITS]

def manager_environment():
    # Only called on Linux. Ignore caller HOME, remote buses, runtime injections,
    # provider keys and custom unit paths. No arbitrary transport or host flags.
    import pwd
    uid = os.geteuid()
    return {'PATH': '/usr/bin:/bin', 'HOME': pwd.getpwuid(uid).pw_dir,
            'LANG': 'C', 'LC_ALL': 'C', 'XDG_RUNTIME_DIR': f'/run/user/{uid}',
            'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{uid}/bus',
            'SYSTEMD_COLORS': '0', 'SYSTEMD_PAGER': 'cat', 'SYSTEMD_LOG_LEVEL': 'err'}

def run_show(*, timeout=5.0, output_limit=MAX_OUTPUT):
    """Bound BOTH pipes before buffering. Discard stderr, never forward native logs."""
    child = subprocess.Popen(command(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=manager_environment(),
                             cwd='/', start_new_session=True)
    chunks, size, deadline = [], 0, time.monotonic()+timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, True)
            selector.register(child.stderr, selectors.EVENT_READ, False)
            while selector.get_map():
                remaining = deadline-time.monotonic()
                need(remaining > 0, 'manager_timeout')
                events = selector.select(remaining)
                need(bool(events), 'manager_timeout')
                for key, _ in events:
                    raw = os.read(key.fd, min(4096, output_limit-size+1))
                    if not raw:
                        selector.unregister(key.fileobj)
                        continue
                    size += len(raw)
                    need(size <= output_limit, 'manager_output_limit')
                    if key.data:
                        chunks.append(raw)
        child.wait(timeout=max(0.001, deadline-time.monotonic()))
        return child.returncode, b''.join(chunks)
    except subprocess.TimeoutExpired:
        raise StatusError('manager_timeout') from None
    finally:
        # The unreaped leader preserves this newly-created group's PID identity.
        # Do not signal a process group after a successful wait/reap.
        if child.returncode is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait()
        child.stdout.close()
        child.stderr.close()

def number(value):
    need(isinstance(value, str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,9})', value),
         'invalid_manager_response')
    result = int(value)
    need(result <= 4294967295, 'invalid_manager_response')
    return result

def parse_units(raw, returncode):
    need(isinstance(raw, bytes) and len(raw) <= MAX_OUTPUT, 'invalid_manager_response')
    try:
        text = raw.decode('utf-8', errors='strict')
    except UnicodeError:
        raise StatusError('invalid_manager_response') from None
    need(not any(ord(c) < 32 and c != '\n' or ord(c) == 127 for c in text),
         'invalid_manager_response')
    records = {}
    for block in re.split(r'\n\n+', text.strip('\n')):
        record = {}
        for line in block.split('\n'):
            key, delimiter, value = line.partition('=')
            need(delimiter and key in PROPERTIES and key not in record, 'invalid_manager_response')
            record[key] = value
        unit = record.get('Id')
        need(unit in UNITS and unit not in records, 'invalid_manager_response')
        need(all(record.get(k) for k in ('LoadState', 'ActiveState', 'SubState')), 'invalid_manager_response')
        if unit.endswith('.service'):
            need(all(k in record for k in ('Type', 'Result', 'ExecMainCode', 'ExecMainStatus', 'NRestarts')),
                 'invalid_manager_response')
        records[unit] = record
    need(set(records) == set(UNITS), 'invalid_manager_response')
    # Match the existing live-service harness: successful show, or the narrowly
    # recognized not-installed result plus complete inactive/not-found evidence.
    # Generic failures (including permission errors) are NOT absence evidence.
    need(type(returncode) is int and (returncode == 0 or returncode == 5 and
         any(r['LoadState'] == 'not-found' and r['ActiveState'] == 'inactive'
             for r in records.values())), 'manager_unavailable')
    return records

def evaluate(records, expect_worker=False):
    units = []
    for name in UNITS:
        r = records[name]
        state = {key: r[key] if r[key] in allowed else 'unknown' for key, allowed in
                 [('LoadState', LOAD), ('ActiveState', ACTIVE), ('SubState', SUB)]}
        service = name.endswith('.service')
        unit_type = (r.get('Type') if r.get('Type') in TYPES else 'unknown') if service else None
        result = (r.get('Result') if r.get('Result') in RESULTS else 'unknown') if service else None
        code = number(r['ExecMainCode']) if service else None
        exit_status = number(r['ExecMainStatus']) if service else None
        restarts = number(r['NRestarts']) if service else None
        active = state['LoadState'] == 'loaded' and state['ActiveState'] == 'active'
        if name == UNITS[1]:
            active = active and state['SubState'] == 'active'
        elif name == UNITS[0]:
            active = active and unit_type == 'oneshot' and state['SubState'] == 'exited' and result == 'success'
        else:
            active = active and unit_type == 'exec' and state['SubState'] == 'running' and result == 'success'
        reason = 'unit_active' if active else 'unit_not_active'
        if state['LoadState'] == 'not-found':
            reason = 'unit_not_found'
        elif state['LoadState'] == 'masked':
            reason = 'unit_masked'
        elif name == UNITS[3] and state['ActiveState'] == 'failed' and result == 'exit-code' and code == 1 and exit_status == 2:
            reason = 'worker_exit_2_check_model_configuration'
        elif state['ActiveState'] == 'failed':
            reason = 'unit_failed'
        elif 'unknown' in state.values() or service and (unit_type == 'unknown' or result == 'unknown'):
            reason = 'unrecognized_unit_state'
        units.append({'unit': name, 'required': name != UNITS[3] or expect_worker,
                      'observed_active': bool(active), 'load_state': state['LoadState'],
                      'active_state': state['ActiveState'], 'sub_state': state['SubState'],
                      'service_type': unit_type, 'result': result, 'main_exit_code': code,
                      'main_exit_status': exit_status, 'restarts': restarts, 'reason': reason})
    ok = all(u['observed_active'] for u in units if u['required'])
    warnings = []
    if any(u['restarts'] for u in units):
        warnings.append('service_restart_observed')
    if not expect_worker and units[3]['active_state'] == 'failed':
        warnings.append('optional_worker_failed')
    if not expect_worker and units[3]['observed_active']:
        warnings.append('worker_running_not_required_by_this_check')
    if not expect_worker and units[3]['load_state'] != 'not-found' and any(
            units[3][k] == 'unknown' for k in ('load_state','active_state','sub_state','service_type','result')):
        warnings.append('optional_worker_state_unrecognized')
    return {'ok': ok, 'status': 'required_units_active' if ok else 'required_units_not_active',
            'units': units, 'warnings': warnings}

def envelope(expect_worker=False):
    return {'format': 1, 'scope': 'local-user-systemd-unit-observation', 'worker_required': expect_worker,
            'configuration_changed': False, 'services_started': False, 'services_stopped': False,
            'database_connected': False, 'console_http_checked': False, 'mcp_checked': False,
            'model_called': False, 'application_ready': 'not_checked',
            'installation_binding_verified': False,
            'snapshot': 'sequential manager properties; states can change during or after the check'}

def collect(expect_worker=False, *, runner=None):
    try:
        need(sys.platform.startswith('linux'), 'unsupported_platform')
        need(os.geteuid() != 0, 'ordinary_linux_user_required')
        code, raw = (runner or run_show)()
        need(bool(raw), 'manager_unavailable')
        return {**envelope(expect_worker), **evaluate(parse_units(raw, code), expect_worker)}
    except Exception as e:
        code = str(e) if isinstance(e, StatusError) and str(e) in SAFE_ERRORS else 'manager_unavailable'
        return {**envelope(expect_worker), 'ok': False, 'status': 'unavailable', 'error': code,
                'units': [], 'warnings': []}

def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if args not in ([], ['--expect-worker']):
        print(json.dumps({**envelope(), 'ok': False, 'status': 'invalid_arguments',
                          'error': 'invalid_arguments', 'units': [], 'warnings': []}))
        return 2
    report = collect(args == ['--expect-worker'])
    print(json.dumps(report, ensure_ascii=True))
    return 0 if report['ok'] else 3 if report['status'] == 'unavailable' else 1

if __name__ == '__main__':
    sys.exit(main())
