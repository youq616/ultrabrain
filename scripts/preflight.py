#!/usr/bin/env python3
"""Offline preflight. Inspect only; never bootstrap, migrate, connect, repair or read memories.

Run with the intended ordinary Linux service account. PATH executables are trusted
operator dependencies, not sandboxed code. Only `bun --version` and fixed
`pkg-config --exists` arguments may execute, with bounded output and no inherited
provider/database credentials. An OK report is not a service health certificate.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import argparse
import contextlib
import errno
import json
import os
from pathlib import Path
import platform
import re
import selectors
import shutil
import signal
import stat
import subprocess
import time
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MAX_CONFIG = 256 * 1024
MIN_BUN = (1, 3, 11)
BUILD_TOOLS = ('bash', 'git', 'make', 'gcc', 'bison', 'flex', 'pkg-config')
RUNTIME_BINARIES = ('postgres', 'pg_ctl', 'psql', 'pg_dump', 'pg_restore', 'createdb')
# Guidance, not a proven installation minimum or a reservation of resources.
MEMORY_WARNING = 2 * 1024**3
DISK_WARNING = 5 * 1024**3

class PreflightError(Exception):
    pass

def require(value, code):
    if not value:
        raise PreflightError(code)

def signature(s):
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

def is_private(s, kind):
    require((stat.S_ISDIR(s.st_mode) if kind == 'directory' else stat.S_ISREG(s.st_mode)), 'wrong_file_type')
    require(s.st_uid == os.geteuid() and not s.st_mode & 0o077, 'owner_only_permissions_required')
    if kind == 'file':
        require(s.st_nlink == 1, 'hardlink_refused')

def absolute_directory(path):
    """Return the deepest existing directory FD and uncreated suffix. Never follow links."""
    path = Path(path)
    require(path.is_absolute() and not any(ord(c) < 32 or ord(c) == 127 for c in str(path)), 'absolute_home_required')
    require('..' not in path.parts, 'ambiguous_home_refused')
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, part in enumerate(path.parts[1:], 1):
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                return fd, path.parts[index:]
            os.close(fd)
            fd = child
        return fd, ()
    except BaseException:
        os.close(fd)
        raise

class PrivateHome:
    """Hold the original directory inode throughout a report, rejecting link/rename swaps."""
    def __init__(self, path):
        self.path = Path(path)
        self.fd, self.missing = absolute_directory(self.path)
        self.initial = os.fstat(self.fd)
        self.observed = {}
        try:
            if not self.missing:
                is_private(self.initial, 'directory')
        except BaseException:
            self.close()
            raise
    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.close()
    def unchanged(self):
        fd, missing = absolute_directory(self.path)
        try:
            current = os.fstat(fd)
            require(missing == self.missing and (current.st_dev, current.st_ino) ==
                    (self.initial.st_dev, self.initial.st_ino), 'home_changed_during_check')
            if not missing:
                is_private(current, 'directory')
            # Catch later replacements between individual checks without rereading
            # credential contents. This is a bounded recheck, not an atomic snapshot.
            for (name, private, directory), expected in self.observed.items():
                self._verify_path(name, private, directory, expected)
        finally:
            os.close(fd)
    def _verify_path(self, name, private, directory, expected):
        try:
            with self._resolve(name, private=private, directory=directory) as (fd, ancestors):
                require((ancestors, signature(os.fstat(fd))) == expected,
                        'managed_path_changed_during_check')
        except OSError:
            raise PreflightError('managed_path_changed_during_check') from None
    @contextlib.contextmanager
    def open(self, name, *, private=True, directory=False):
        with self._resolve(name, private=private, directory=directory) as (fd, ancestors):
            expected = ancestors, signature(os.fstat(fd))
            key = name, private, directory
            if key in self.observed:
                require(self.observed[key] == expected, 'managed_path_changed_during_check')
            yield fd
            # fstat alone follows the original inode after an ancestor rename.
            # Rewalk from the held home descriptor before accepting this result.
            self._verify_path(name, private, directory, expected)
            self.observed[key] = expected
    @contextlib.contextmanager
    def _resolve(self, name, *, private=True, directory=False):
        require(not self.missing, 'not_installed')
        # All callers supply program-owned relative paths, never a path read from a file.
        parts = Path(name).parts
        require(parts and not Path(name).is_absolute() and all(p not in ('.', '..') for p in parts), 'unsafe_managed_path')
        parent = os.dup(self.fd)
        ancestors = []
        leaf = None
        try:
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent)
                parent = child
                # Native/state ancestors are private; runtime/bin internals may be readable
                # inside an explicitly private runtime prefix, but never other-writable.
                s = os.fstat(parent)
                ancestors.append((s.st_dev, s.st_ino))
                require(s.st_uid == os.geteuid() and not s.st_mode & (0o077 if private else 0o022),
                        'owner_only_permissions_required')
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if directory:
                flags |= os.O_DIRECTORY
            leaf = os.open(parts[-1], flags, dir_fd=parent)
            s = os.fstat(leaf)
            if private:
                is_private(s, 'directory' if directory else 'file')
            else:
                require((stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode))
                        and s.st_uid == os.geteuid() and not s.st_mode & 0o022, 'unsafe_runtime_file')
                if not directory:
                    require(s.st_nlink == 1, 'hardlink_refused')
            yield leaf, tuple(ancestors)
        finally:
            if leaf is not None:
                os.close(leaf)
            os.close(parent)
    def read(self, name, limit=MAX_CONFIG, *, private=True):
        with self.open(name, private=private) as fd:
            before = os.fstat(fd)
            require(before.st_size <= limit, 'config_too_large')
            parts, size = [], 0
            while True:
                raw = os.read(fd, min(65536, limit - size + 1))
                if not raw:
                    break
                size += len(raw)
                require(size <= limit, 'config_too_large')
                parts.append(raw)
            require(signature(before) == signature(os.fstat(fd)) and size == before.st_size,
                    'file_changed_during_check')
            return b''.join(parts)
    def metadata(self, name, *, directory=False, private=True):
        with self.open(name, directory=directory, private=private) as fd:
            return os.fstat(fd)

def object_json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'duplicate_config_key')
            value[key] = item
        return value
    def invalid(_):
        raise PreflightError('invalid_json')
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique, parse_constant=invalid)
    except (UnicodeError, ValueError, RecursionError):
        raise PreflightError('invalid_json') from None
    require(isinstance(value, dict), 'object_config_required')
    return value

def run_local(args, *, timeout=3, output_limit=4096):
    """Fixed dependency probes only. Bound stdout/stderr before buffering, including descendants."""
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C', 'LC_ALL': 'C'}
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, env=env, cwd='/', start_new_session=True)
    chunks, size, deadline = [], 0, time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'dependency_probe_timeout')
                if not selector.select(remaining):
                    raise PreflightError('dependency_probe_timeout')
                raw = os.read(child.stdout.fileno(), min(4096, output_limit - size + 1))
                if not raw:
                    break
                size += len(raw)
                require(size <= output_limit, 'dependency_output_limit')
                chunks.append(raw)
        child.wait(timeout=max(0.001, deadline-time.monotonic()))
        require(child.returncode == 0, 'dependency_probe_failed')
        return b''.join(chunks)
    except subprocess.TimeoutExpired:
        raise PreflightError('dependency_probe_timeout') from None
    finally:
        # Include descendants that may still retain pipes; only this newly created group.
        if child.returncode is None:
            # The leader has not been reaped: its PID cannot yet be reused.
            # Do not signal a process group after a successful wait/reap.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait()
        child.stdout.close()

def dependency_path(name):
    # which() may return a relative PATH entry. Bind it before run_local changes
    # cwd to /, so the probe executes the dependency selected in this process.
    found = shutil.which(name)
    return os.path.abspath(found) if found is not None else None

def failure_code(error):
    if isinstance(error, PreflightError):
        return str(error)
    if isinstance(error, FileNotFoundError):
        return 'missing'
    if isinstance(error, PermissionError):
        return 'not_readable'
    if isinstance(error, OSError) and error.errno in (errno.ELOOP, errno.ENOTDIR):
        return 'link_or_non_directory_refused'
    return 'check_failed'  # Never expose OS/parser/command messages, paths or content.

class Report:
    def __init__(self, mode):
        self.mode, self.checks = mode, []
    def add(self, name, status, code):
        self.checks.append({'id': name, 'status': status, 'code': code})
    def attempt(self, name, action, *, missing='fail'):
        try:
            result = action()
            self.add(name, 'pass', 'verified_offline')
            return result
        except Exception as error:
            code = failure_code(error)
            self.add(name, missing if code == 'missing' else 'fail', code)
            return None
    def result(self):
        return {'format': 1, 'ok': not any(c['status'] == 'fail' for c in self.checks),
                'mode': self.mode, 'scope': 'offline-local-preflight', 'checks': self.checks,
                'live_service_verified': False, 'database_connected': False, 'model_called': False,
                'changes_made': False,
                'limitations': ['not a live database or MCP health check', 'does not install or repair anything',
                                'does not verify all dependency integrity, client hooks, backups or model quality',
                                'PATH dependency executables must be trusted; this is not a sandbox'],
                'next_step': 'review failures; then bootstrap only if intended' if self.mode == 'install'
                             else 'run health and an authenticated client probe separately'}

@contextlib.contextmanager

def source_entry(root, relative, *, directory=False):
    """Metadata/config from fixed checkout paths; refuse links without importing source."""
    fd, missing = absolute_directory(root)
    leaf = None
    try:
        require(not missing, 'application_checkout_missing')
        parts = Path(relative).parts
        require(parts and not Path(relative).is_absolute() and '..' not in parts, 'unsafe_source_path')
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if directory:
            flags |= os.O_DIRECTORY
        leaf = os.open(parts[-1], flags, dir_fd=fd)
        s = os.fstat(leaf)
        require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode), 'source_wrong_type')
        yield leaf
    finally:
        if leaf is not None:
            os.close(leaf)
        os.close(fd)

def check_source_path(root, name, directory=False):
    with source_entry(root, name, directory=directory):
        return True

def check_pins(root):
    # Fixed trusted application lock; no runtime imports and no paths from the JSON.
    with source_entry(root, 'upstreams.lock.json') as fd:
        before = os.fstat(fd)
        require(before.st_size <= MAX_CONFIG, 'invalid_upstream_lock')
        chunks, size = [], 0
        while True:
            raw = os.read(fd, min(65536, MAX_CONFIG - size + 1))
            if not raw:
                break
            size += len(raw)
            require(size <= MAX_CONFIG, 'invalid_upstream_lock')
            chunks.append(raw)
        require(signature(before) == signature(os.fstat(fd)) and size == before.st_size, 'source_lock_changed')
        pins = object_json(b''.join(chunks)).get('projects')
    require(isinstance(pins, dict), 'invalid_upstream_lock')
    for name in ('gbrain', 'postgres', 'pgvector'):
        p = pins.get(name)
        require(isinstance(p, dict) and isinstance(p.get('revision'), str)
                and re.fullmatch(r'[a-f0-9]{40}', p['revision']), 'invalid_upstream_lock')
    require(re.fullmatch(r'[0-9]+\.[0-9]+', pins['postgres'].get('version', '')), 'invalid_upstream_lock')
    return pins

def validate_binding(binding, pins):
    require(binding.get('version') == pins['postgres']['version'] and
            binding.get('postgres_revision') == pins['postgres']['revision'] and
            binding.get('pgvector_revision') == pins['pgvector']['revision'], 'runtime_pin_mismatch')
    base = 'postgres-' + pins['postgres']['version'] + '-' + pins['postgres']['revision'][:12]
    vector = base + '-pgvector-' + pins['pgvector']['revision'][:12]
    require(binding.get('directory') in (base, vector, vector+'-portable-v1'), 'invalid_runtime_directory')
    return binding['directory']

def validate_state(state):
    require(type(state.get('port')) is int and 1024 <= state['port'] <= 65535, 'invalid_database_state')
    for key in ('app_password', 'admin_password'):
        value = state.get(key)
        require(isinstance(value, str) and 0 < len(value) <= 4096 and
                not any(ord(c) < 32 or ord(c) == 127 for c in value), 'invalid_database_state')
    return state

def validate_database(config, state):
    raw = config.get('database_url')
    require(config.get('engine') == 'postgres' and isinstance(raw, str) and len(raw) <= 32768
            and not re.search(r'[\x00-\x20\x7f]|%(?![0-9a-fA-F]{2})', raw), 'managed_database_mismatch')
    try:
        url = urlsplit(raw)
        good = (url.scheme == 'postgresql' and url.hostname == '127.0.0.1' and
                url.port == state['port'] and url.username == 'ultrabrain' and
                unquote(url.password or '', errors='strict') == state['app_password'] and
                url.path == '/ultrabrain' and not url.query and not url.fragment)
    except (ValueError, UnicodeError):
        good = False
    require(good, 'managed_database_mismatch')
    return True

def disk_and_memory(report, view):
    try:
        space = os.fstatvfs(view.fd)
        available = space.f_bavail * space.f_frsize
        report.add('disk_headroom', 'pass' if available >= DISK_WARNING else 'warn',
                   'space_available_not_reserved' if available >= DISK_WARNING else 'under_5gib_free_guidance')
    except OSError:
        report.add('disk_headroom', 'not_checked', 'disk_space_unknown')
    try:
        with open('/proc/meminfo', 'rb') as stream:
            raw = stream.read(32769)
        match = re.search(rb'^MemAvailable:\s+(\d+) kB$', raw, re.M)
        require(match and len(raw) <= 32768, 'memory_unknown')
        available = int(match[1]) * 1024
        report.add('memory_headroom', 'pass' if available >= MEMORY_WARNING else 'warn',
                   'host_estimate_not_cgroup_guarantee' if available >= MEMORY_WARNING else 'under_2gib_available_guidance')
    except Exception:
        report.add('memory_headroom', 'not_checked', 'memory_unknown')

def preflight(mode='install', home=None, *, root=ROOT):
    require(mode in ('install', 'runtime'), 'invalid_mode')
    report = Report(mode)
    if platform.system() != 'Linux':
        report.add('platform', 'fail', 'server_requires_linux')
        return report.result()
    report.add('platform', 'pass', 'linux')
    if os.geteuid() == 0:
        report.add('service_user', 'fail', 'use_ordinary_service_account')
        return report.result()  # Never inspect root's or another account's private state.
    report.add('service_user', 'pass', 'ordinary_account')
    report.add('python', 'pass' if sys.version_info >= (3, 11) else 'fail',
               'supported' if sys.version_info >= (3, 11) else 'python_3_11_required')
    home = Path(home if home is not None else os.environ.get('ULTRABRAIN_HOME', Path.home()/'.local/share/ultrabrain'))
    # No resolver/repair and no implicit follow of a symlinked home.
    require(home.is_absolute() and '..' not in home.parts, 'absolute_home_required')
    require(root != home and root not in home.parents and home not in root.parents, 'home_overlaps_repository')
    view = report.attempt('private_home', lambda: PrivateHome(home))
    if view is None:
        return report.result()
    with view:
        if view.missing:
            report.add('installation', 'warn' if mode == 'install' else 'fail', 'not_installed_no_directory_created')
        else:
            report.add('installation', 'warn' if mode == 'install' else 'pass',
                       'existing_home_not_overwritten' if mode == 'install' else 'home_present')
        report.attempt('home_write_access', lambda: require(
            os.access('.', os.W_OK | os.X_OK, dir_fd=view.fd, effective_ids=True),
            'planned_home_parent_not_writable' if view.missing else 'home_not_writable'))
        disk_and_memory(report, view)
        pins = report.attempt('upstream_lock', lambda: check_pins(root))
        bun = dependency_path('bun')
        if not bun:
            report.add('bun', 'fail', 'bun_not_found')
        else:
            def bun_version():
                raw = run_local([bun, '--version'])
                match = re.fullmatch(rb'(\d+)\.(\d+)\.(\d+)(?:\+[a-zA-Z0-9.-]+)?\s*', raw)
                require(match and tuple(map(int, match.groups())) >= MIN_BUN, 'bun_1_3_11_stable_required')
            report.attempt('bun', bun_version)
        if mode == 'install':
            found = {name: dependency_path(name) for name in BUILD_TOOLS}
            for name, path in found.items():
                report.add('tool_'+name.replace('-', '_'), 'pass' if path else 'fail', 'found' if path else 'missing')
            if found['pkg-config']:
                report.attempt('build_headers', lambda: run_local([found['pkg-config'], '--exists', 'openssl', 'zlib']))
            report.add('upstream_checkout', 'not_checked', 'bootstrap_fetches_pinned_runtime_sources')
        elif not view.missing and pins:
            state = report.attempt('database_state', lambda: validate_state(object_json(view.read('postgres/state.json'))))
            binding = report.attempt('runtime_binding', lambda: validate_binding(object_json(view.read('postgres/runtime.json')), pins))
            config = report.attempt('native_config', lambda: object_json(view.read('gbrain/.gbrain/config.json')))
            if state is not None and config is not None:
                report.attempt('managed_database_config', lambda: validate_database(config, state))
            if config is None:
                # Detect only the historical file's safe metadata; never apply or echo it.
                report.attempt('legacy_config', lambda: view.metadata('gbrain/config.json'), missing='not_checked')
            if binding:
                prefix = 'runtime/'+binding
                report.attempt('runtime_directory', lambda: view.metadata(prefix, directory=True))
                def marker():
                    raw = view.read(prefix+'/.ultrabrain-build', 256, private=False)
                    require(raw.strip() == (pins['postgres']['revision']+':'+pins['pgvector']['revision']).encode('ascii'),
                            'runtime_build_marker_mismatch')
                report.attempt('runtime_build_marker', marker)
                for name in RUNTIME_BINARIES:
                    def executable(name=name):
                        s = view.metadata(prefix+'/bin/'+name, private=False)
                        require(s.st_mode & stat.S_IXUSR, 'runtime_binary_not_executable')
                    report.attempt('runtime_'+name, executable)
            def pg_version():
                raw = view.read('postgres/data/PG_VERSION', 32)
                require(raw.strip().decode('ascii') == pins['postgres']['version'].split('.')[0], 'cluster_major_mismatch')
            report.attempt('cluster_major', pg_version)
            for name, path in [('native_entrypoint', 'vendor/gbrain/src/cli.ts'), ('native_dependencies', 'vendor/gbrain/node_modules')]:
                report.attempt(name, lambda path=path, name=name:
                               check_source_path(root, path, directory=name=='native_dependencies'))
            for name, path in [('service_environment', 'service.env'), ('console_token', 'personal-console-token')]:
                # Credentials are NOT read or copied by these optional metadata checks.
                report.attempt(name, lambda path=path: view.metadata(path), missing='not_checked')
        report.attempt('home_unchanged', view.unchanged)
        report.add('live_database_and_mcp', 'not_checked', 'run_health_and_client_probe_separately')
    return report.result()

class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise PreflightError('invalid_arguments')  # argparse would otherwise echo arbitrary argument text.

def main(argv=None):
    try:
        parser = Parser(description=__doc__)
        parser.add_argument('--mode', choices=('install', 'runtime'), default='install')
        parser.add_argument('--home', help='Explicit planned/existing ULTRABRAIN_HOME; never created')
        args = parser.parse_args(argv)
        result = preflight(args.mode, args.home)
        print(json.dumps(result, sort_keys=True))
        return 0 if result['ok'] else 1
    except Exception as error:
        print(json.dumps({'format': 1, 'ok': False, 'scope': 'offline-local-preflight',
                          'error': failure_code(error), 'changes_made': False}))
        return 2

if __name__ == '__main__':
    sys.exit(main())
