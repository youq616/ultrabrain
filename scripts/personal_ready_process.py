"""Read-only Linux process and selected managed PostgreSQL bindings.

These are bounded observations, not a lock against an actor with the same UID.
The caller must compare snapshots around its authenticated readiness exchange.
No commands, signals, environment files, memory records or network operations
are performed here. PROC_ROOT is a fixed production path; fixtures patch it in
Python, never through a command-line option or an environment variable.
"""
from contextlib import contextmanager
import importlib.util
import os
from pathlib import Path
import re
import stat


def _module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


PREFLIGHT = _module('ultrabrain_ready_preflight', 'preflight.py')
FS = _module('ultrabrain_ready_store', 'personal_deploy_store.py')
PROC_ROOT = Path('/proc')
CONSOLE_UNIT = 'ultrabrain-personal-console.service'


class ReadyError(Exception):
    pass


def need(value, code):
    if not value:
        raise ReadyError(code)


@contextmanager
def _safe_errors():
    try:
        yield
    except (PREFLIGHT.PreflightError, FS.DeployError) as error:
        raise ReadyError(str(error)) from None
    except OSError:
        raise ReadyError('managed_process_not_readable') from None


def _number(value, code, *, zero=False, maximum=2147483647):
    if isinstance(value, str):
        need(re.fullmatch(r'0|[1-9][0-9]{0,19}', value), code)
        value = int(value)
    need(type(value) is int and (0 if zero else 1) <= value <= maximum, code)
    return value


def _metadata(value):
    return FS.metadata(value)


def _read(fd, name, limit):
    """Only fixed proc filenames; procfs size is normally zero, so count bytes."""
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        before = os.fstat(child)
        need(stat.S_ISREG(before.st_mode), 'unsafe_proc_entry')
        chunks, size = [], 0
        while True:
            raw = os.read(child, min(16384, limit - size + 1))
            if not raw:
                break
            size += len(raw)
            need(size <= limit, 'proc_file_too_large')
            chunks.append(raw)
        need(_metadata(os.fstat(child)) == _metadata(before)
             and _metadata(os.stat(name, dir_fd=fd, follow_symlinks=False)) == _metadata(before),
             'proc_file_changed')
        return b''.join(chunks)
    finally:
        os.close(child)


@contextmanager
def _proc_directory(pid):
    pid = _number(pid, 'invalid_process_id')
    root = os.open(PROC_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    child = None
    try:
        child = os.open(str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        before = FS.identity(os.fstat(child))
        yield child, before
        # The original descriptor stays bound to the original task even if a PID
        # is reused; also reject a newly visible directory at that numeric path.
        need(FS.identity(os.fstat(child)) == before
             and FS.identity(os.stat(str(pid), dir_fd=root, follow_symlinks=False)) == before,
             'process_identity_changed')
    finally:
        if child is not None:
            os.close(child)
        os.close(root)


def _namespaces(fd):
    child = os.open('ns', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        result = {}
        for name in ('pid', 'net'):
            value = os.readlink(name, dir_fd=child)
            need(re.fullmatch(name + r':\[[1-9][0-9]{0,19}\]', value), 'invalid_process_namespace')
            result[name] = value
        return result
    finally:
        os.close(child)


def _self_namespaces():
    with _proc_directory(os.getpid()) as (fd, _):
        result = _namespaces(fd)
        need(_namespaces(fd) == result, 'process_namespace_changed')
        return result


def _parse_stat(raw, pid):
    # comm can contain spaces and parentheses; the numeric tail cannot contain
    # ') ', so its last occurrence is the only safe split point.
    prefix = str(pid).encode('ascii') + b' ('
    end = raw.rfind(b') ')
    need(raw.startswith(prefix) and end >= len(prefix), 'invalid_proc_stat')
    fields = raw[end + 2:].split()
    need(20 <= len(fields) <= 128 and fields[0] in (b'R', b'S', b'D', b'I'),
         'process_not_live')
    need(all(re.fullmatch(rb'-?[0-9]{1,20}', value) for value in fields[1:]), 'invalid_proc_stat')
    return {'pid': pid, 'ppid': _number(fields[1].decode('ascii'), 'invalid_proc_stat', zero=True),
            'start_ticks': _number(fields[19].decode('ascii'), 'invalid_proc_stat', maximum=2**64 - 1)}


def _parse_status(raw, expected, uid):
    values = {}
    for line in raw.splitlines():
        key, separator, value = line.partition(b':')
        if separator and key in (b'Uid', b'Pid', b'Tgid', b'PPid'):
            need(key not in values, 'invalid_proc_status')
            values[key] = value.split()
    need(set(values) == {b'Uid', b'Pid', b'Tgid', b'PPid'}, 'invalid_proc_status')
    need(values[b'Uid'] == [str(uid).encode('ascii')] * 4, 'process_uid_mismatch')
    for key, wanted in ((b'Pid', expected['pid']), (b'Tgid', expected['pid']), (b'PPid', expected['ppid'])):
        need(values[key] == [str(wanted).encode('ascii')], 'process_identity_changed')


@contextmanager
def _executable(path, uid):
    path = FS.absolute(path)
    store = FS.Store(uid)
    with store.directory(path.parent) as parent:
        fd = os.open(path.name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_uid in (0, uid)
                 and before.st_nlink == 1 and not before.st_mode & 0o022
                 and before.st_mode & stat.S_IXUSR, 'unsafe_process_executable')
            value = _metadata(before)
            yield value
            need(_metadata(os.fstat(fd)) == value
                 and _metadata(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) == value,
                 'process_executable_changed')
            store.visible(parent, path.parent)
        finally:
            os.close(fd)


def _process_executable(fd, expected, metadata):
    # The only deliberately followed proc magic link. It is kernel supplied,
    # must name the exact trusted executable, and its open inode must match it.
    need(os.readlink('exe', dir_fd=fd) == expected, 'process_executable_mismatch')
    child = os.open('exe', os.O_PATH, dir_fd=fd)
    try:
        need(_metadata(os.fstat(child)) == metadata
             and os.readlink('exe', dir_fd=fd) == expected, 'process_executable_mismatch')
    finally:
        os.close(child)


def _process_cwd(fd, expected):
    path, identity = expected
    need(os.readlink('cwd', dir_fd=fd) == path, 'postmaster_working_directory_mismatch')
    child = os.open('cwd', os.O_PATH | os.O_DIRECTORY, dir_fd=fd)
    try:
        need(FS.identity(os.fstat(child)) == identity
             and os.readlink('cwd', dir_fd=fd) == path, 'postmaster_working_directory_mismatch')
    finally:
        os.close(child)


def _process_snapshot(pid, *, executable, uid, command=None, cgroup=None, cwd=None):
    pid = _number(pid, 'invalid_process_id')
    uid = _number(uid, 'invalid_process_uid', zero=True)
    executable = str(FS.absolute(executable))
    namespaces = _self_namespaces()
    with _executable(executable, uid) as metadata:
        with _proc_directory(pid) as (fd, directory):
            need(os.fstat(fd).st_uid == uid, 'process_uid_mismatch')
            previous = None
            for _ in range(2):
                current = _parse_stat(_read(fd, 'stat', 8192), pid)
                _parse_status(_read(fd, 'status', 65536), current, uid)
                _process_executable(fd, executable, metadata)
                if cwd is not None:
                    _process_cwd(fd, cwd)
                need(_namespaces(fd) == namespaces, 'process_namespace_mismatch')
                if command is not None:
                    expected = b'\0'.join(os.fsencode(value) for value in command) + b'\0'
                    need(_read(fd, 'cmdline', 32768) == expected, 'process_command_mismatch')
                if cgroup is not None:
                    need(_read(fd, 'cgroup', 16384) == ('0::' + cgroup + '\n').encode('utf-8'),
                         'process_cgroup_mismatch')
                need(_parse_stat(_read(fd, 'stat', 8192), pid) == current,
                     'process_identity_changed')
                need(previous is None or previous == current, 'process_identity_changed')
                previous = current
            need(_self_namespaces() == namespaces, 'process_namespace_changed')
            return {**current, 'uid': uid, 'executable': executable,
                    'executable_identity': metadata, 'namespaces': namespaces,
                    'proc_identity': directory}


def console_snapshot(row, *, root, bun, source, port, uid=None):
    """Bind a separately verified systemctl row to its actual Bun process."""
    with _safe_errors():
        uid = os.geteuid() if uid is None else uid
        root, bun = str(FS.absolute(root)), str(FS.absolute(bun))
        need(isinstance(row, dict) and row.get('Id') == CONSOLE_UNIT, 'invalid_console_process')
        invocation = row.get('InvocationID')
        need(isinstance(invocation, str) and re.fullmatch(r'[a-f0-9]{32}', invocation)
             and invocation != '0' * 32, 'invalid_console_invocation')
        cgroup = row.get('ControlGroup')
        need(isinstance(cgroup, str) and len(cgroup.encode('utf-8')) <= 4096
             and cgroup.startswith('/') and cgroup.endswith('/' + CONSOLE_UNIT)
             and all(part not in ('', '.', '..') for part in cgroup.split('/')[1:])
             and not any(ord(char) < 32 or ord(char) == 127 for char in cgroup), 'invalid_console_cgroup')
        need(isinstance(source, str) and re.fullmatch(r'[a-z0-9-]{1,32}', source), 'invalid_source')
        need(type(port) is int and 1024 <= port <= 65535, 'invalid_console_port')
        command = [bun, '--no-env-file', root + '/src/cli.mjs', 'personal-ui',
                   '--source', source, '--port', str(port)]
        value = _process_snapshot(row.get('MainPID'), executable=bun, uid=uid,
                                  command=command, cgroup=cgroup)
        return {**value, 'invocation_id': invocation, 'control_group': cgroup}


def _postmaster_file(raw, home, port):
    need(len(raw) <= 12288 and b'\0' not in raw, 'invalid_postmaster_file')
    lines = raw.split(b'\n')
    need(len(lines) == 9 and lines[-1] == b'', 'invalid_postmaster_file')
    need(all(not any(char < 32 or char == 127 for char in line) for line in lines[:-1]),
         'invalid_postmaster_file')
    try:
        pid = _number(lines[0].decode('ascii'), 'invalid_postmaster_pid')
        started = _number(lines[2].decode('ascii'), 'invalid_postmaster_start', maximum=2**53 - 1)
    except UnicodeError:
        raise ReadyError('invalid_postmaster_file') from None
    need(lines[1] == os.fsencode(str(home / 'postgres/data')), 'postmaster_data_directory_mismatch')
    need(lines[3] == str(port).encode('ascii'), 'postmaster_port_mismatch')
    need(len(lines[4]) <= 4096 and (not lines[4] or lines[4].startswith(b'/')),
         'invalid_postmaster_file')
    need(lines[5] == b'127.0.0.1', 'postmaster_listen_address_mismatch')
    need(re.fullmatch(rb' *[0-9]{1,20} +[0-9]{1,20} *', lines[6]), 'invalid_postmaster_file')
    need(re.fullmatch(rb'ready {0,3}', lines[7]), 'postmaster_not_ready')
    return pid, started


def database_snapshot(view, pins):
    """Certify private configuration and the live postmaster it selects.

    The supplied PrivateHome remains held by the caller. Credentials are used
    solely by preflight's managed URL comparison and never enter the snapshot.
    A build marker and executable inode are bindings, not a binary-content audit.
    """
    with _safe_errors():
        home = FS.absolute(view.path)
        state = PREFLIGHT.validate_state(PREFLIGHT.object_json(view.read('postgres/state.json')))
        config = PREFLIGHT.object_json(view.read('gbrain/.gbrain/config.json'))
        PREFLIGHT.validate_database(config, state)
        binding = PREFLIGHT.validate_binding(PREFLIGHT.object_json(view.read('postgres/runtime.json')), pins)
        prefix = 'runtime/' + binding
        view.metadata(prefix, directory=True)
        marker = view.read(prefix + '/.ultrabrain-build', 256, private=False)
        need(marker.strip() == (pins['postgres']['revision'] + ':' + pins['pgvector']['revision']).encode('ascii'),
             'runtime_build_marker_mismatch')
        need(view.read('postgres/data/PG_VERSION', 32).strip() == pins['postgres']['version'].split('.')[0].encode('ascii'),
             'cluster_major_mismatch')
        executable = prefix + '/bin/postgres'
        executable_metadata = _metadata(view.metadata(executable, private=False))
        raw = view.read('postgres/data/postmaster.pid', 12288)
        pid, started = _postmaster_file(raw, home, state['port'])
        # PostgreSQL's PostmasterMain calls ChangeToDataDir before publishing a
        # ready PID file. Bind the actual cwd too: a stale PID file alone can
        # accidentally name a recycled PID serving a different data directory.
        with view.open('postgres/data', directory=True) as data_fd:
            data_identity = FS.identity(os.fstat(data_fd))
            process = _process_snapshot(pid, executable=str(home / executable), uid=os.geteuid(),
                                        cwd=(str(home / 'postgres/data'), data_identity))
        need(process['executable_identity'] == executable_metadata, 'process_executable_changed')
        need(view.read('postgres/data/postmaster.pid', 12288) == raw, 'postmaster_file_changed')
        view.unchanged()
        return {'port': state['port'], 'data_directory': str(home / 'postgres/data'),
                'data_directory_identity': data_identity, 'runtime_directory': binding,
                'postmaster_started': started, 'postmaster': process}


def verify_backend(database, backend_pid, *, uid=None):
    """Bind a PID from authenticated SQL to the selected postmaster's child."""
    with _safe_errors():
        uid = os.geteuid() if uid is None else uid
        postmaster = database['postmaster']
        need(uid == postmaster['uid'], 'process_uid_mismatch')
        process = _process_snapshot(backend_pid, executable=postmaster['executable'], uid=uid,
                                    cwd=(database['data_directory'], database['data_directory_identity']))
        need(process['ppid'] == postmaster['pid'] and process['pid'] != postmaster['pid']
             and process['start_ticks'] >= postmaster['start_ticks'], 'backend_postmaster_mismatch')
        need(process['executable_identity'] == postmaster['executable_identity']
             and process['namespaces'] == postmaster['namespaces'], 'backend_runtime_mismatch')
        return process
