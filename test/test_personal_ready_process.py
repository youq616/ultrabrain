"""Synthetic proc/private-home fixtures; no service, database or provider starts."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('personal_ready_process_tests', ROOT / 'scripts/personal_ready_process.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ProcessFixture(unittest.TestCase):
    def setUp(self):
        previous = os.umask(0o077)
        self.addCleanup(os.umask, previous)
        temporary = tempfile.TemporaryDirectory(prefix='ub-ready-process-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.proc = self.base / 'proc'
        self.proc.mkdir(mode=0o700)
        self.uid = os.geteuid()
        self.root = self.base / 'repo'
        self.root.mkdir(mode=0o700)
        self.bun = self.base / 'bun'
        self.bun.write_bytes(b'SYNTHETIC_EXECUTABLE_NOT_RUN')
        self.bun.chmod(0o700)
        self.pid = 424241
        self.cgroup = '/user.slice/user-1000.slice/user@1000.service/app.slice/' + m.CONSOLE_UNIT
        self.command = [str(self.bun), '--no-env-file', str(self.root / 'src/cli.mjs'),
                        'personal-ui', '--source', 'private-source', '--port', '3132']
        self.row = {'Id': m.CONSOLE_UNIT, 'InvocationID': 'a' * 32,
                    'ControlGroup': self.cgroup, 'MainPID': str(self.pid)}
        self.process(self.pid, self.bun, command=self.command, cgroup=self.cgroup)
        if os.getpid() != self.pid:
            self.process(os.getpid(), self.bun)
        patched = patch.object(m, 'PROC_ROOT', self.proc)
        patched.start()
        self.addCleanup(patched.stop)

    def write(self, target, raw):
        target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        target.write_bytes(raw)
        return target

    def process_stat(self, pid, *, ppid=1234, start=123456, state='S', comm='synthetic process'):
        # Fields 3 through 22: state, PPid, then 17 irrelevant numeric fields,
        # then starttime. The remaining real kernel fields are numeric too.
        return (str(pid) + ' (' + comm + ') ' + ' '.join(
            [state, str(ppid)] + ['0'] * 17 + [str(start)] + ['0'] * 30) + '\n').encode('utf-8')

    def process(self, pid, executable, *, ppid=1234, start=123456, command=None, cgroup='/', cwd=None):
        directory = self.proc / str(pid)
        directory.mkdir(mode=0o700, exist_ok=True)
        self.write(directory / 'stat', self.process_stat(pid, ppid=ppid, start=start))
        self.write(directory / 'status', (f'Name:\tsynthetic\nPid:\t{pid}\nTgid:\t{pid}\n'
                   f'PPid:\t{ppid}\nUid:\t{self.uid}\t{self.uid}\t{self.uid}\t{self.uid}\n').encode())
        self.write(directory / 'cmdline', b'\0'.join(os.fsencode(p) for p in (command or [str(executable)])) + b'\0')
        self.write(directory / 'cgroup', ('0::' + cgroup + '\n').encode())
        (directory / 'exe').symlink_to(executable)
        (directory / 'ns').mkdir(mode=0o700)
        for name, number in (('pid', 4026531836), ('net', 4026531992)):
            (directory / 'ns' / name).symlink_to(f'{name}:[{number}]')
        if cwd is not None:
            (directory / 'cwd').symlink_to(cwd)
        return directory

    def console(self, **changes):
        options = {'root': self.root, 'bun': self.bun, 'source': 'private-source', 'port': 3132}
        options.update(changes)
        return m.console_snapshot(self.row, **options)

    def rejects(self, action, code=None):
        with self.assertRaises(m.ReadyError) as caught:
            action()
        if code is not None:
            self.assertEqual(str(caught.exception), code)
        self.assertNotIn('SYNTHETIC_PRIVATE', str(caught.exception))


class ConsoleProcessTests(ProcessFixture):
    def test_valid_console_snapshot_is_stable_and_json_safe(self):
        result = self.console()
        self.assertEqual(result, json.loads(json.dumps(result)))
        self.assertEqual(result, self.console())
        self.assertEqual(result['pid'], self.pid)
        self.assertEqual(result['start_ticks'], 123456)
        self.assertEqual(result['invocation_id'], 'a' * 32)
        self.assertEqual(result['executable_identity'][:2], [self.bun.stat().st_dev, self.bun.stat().st_ino])

    def test_invalid_manager_pid_is_refused(self):
        for value in (None, '', '0', '-1', '001', True, 2147483648, '../42', '1\n', '9' * 100):
            with self.subTest(value=value):
                self.row['MainPID'] = value
                self.rejects(self.console, 'invalid_process_id')

    def test_invocation_id_is_canonical_and_nonzero(self):
        for value in (None, '', '0' * 32, 'A' * 32, 'a' * 31, 'a' * 33, 'a' * 32 + '\n'):
            with self.subTest(value=value):
                self.row['InvocationID'] = value
                self.rejects(self.console, 'invalid_console_invocation')

    def test_only_console_unit_is_allowed(self):
        self.row['Id'] = 'another.service'
        self.rejects(self.console, 'invalid_console_process')

    def test_cgroup_must_be_absolute_canonical_console_group(self):
        for value in ('', '/', '../' + m.CONSOLE_UNIT, '/foo/../' + m.CONSOLE_UNIT,
                      '//foo/' + m.CONSOLE_UNIT, '/foo/another.service', '/foo\n/' + m.CONSOLE_UNIT):
            with self.subTest(value=value):
                self.row['ControlGroup'] = value
                self.rejects(self.console, 'invalid_console_cgroup')

    def test_source_and_port_are_validated_before_proc_reads(self):
        for change in ({'source': 'SYNTHETIC_PRIVATE'}, {'source': 'a' * 33}, {'port': True},
                       {'port': '3132'}, {'port': 80}, {'port': 65536}):
            with self.subTest(change=change):
                self.rejects(lambda: self.console(**change))

    def test_full_command_is_required_not_just_process_name(self):
        for command in (self.command[:-1] + ['3133'], self.command + ['--token-file', '/private'],
                        self.command[1:], self.command[:4] + ['--source', 'another', '--port', '3132']):
            with self.subTest(command=command):
                self.write(self.proc / str(self.pid) / 'cmdline', b'\0'.join(os.fsencode(p) for p in command) + b'\0')
                self.rejects(self.console, 'process_command_mismatch')

    def test_cmdline_requires_exact_nul_termination(self):
        path = self.proc / str(self.pid) / 'cmdline'
        raw = path.read_bytes()
        for altered in (raw[:-1], raw + b'\0', raw.replace(b'\0', b' ')):
            self.write(path, altered)
            self.rejects(self.console, 'process_command_mismatch')

    def test_executable_cannot_be_deleted_or_point_to_another_path(self):
        path = self.proc / str(self.pid) / 'exe'
        for target in (str(self.bun) + ' (deleted)', '/another/bun'):
            path.unlink()
            path.symlink_to(target)
            self.rejects(self.console, 'process_executable_mismatch')

    def test_same_executable_text_cannot_hide_different_open_inode(self):
        other = self.write(self.base / 'other-bun', b'DIFFERENT_EXECUTABLE')
        other.chmod(0o700)
        path = self.proc / str(self.pid) / 'exe'
        path.unlink()
        path.symlink_to(other)
        readlink = os.readlink
        with patch.object(m.os, 'readlink', side_effect=lambda name, **kw:
                          str(self.bun) if name == 'exe' else readlink(name, **kw)):
            self.rejects(self.console, 'process_executable_mismatch')

    def test_trusted_bun_symlink_or_writable_binary_is_refused(self):
        alias = self.base / 'bun-alias'
        alias.symlink_to(self.bun)
        self.rejects(lambda: self.console(bun=alias), 'unsafe_process_executable')
        self.bun.chmod(0o722)
        self.rejects(self.console, 'unsafe_process_executable')

    def test_trusted_executable_hardlink_is_refused(self):
        os.link(self.bun, self.base / 'bun-hardlink')
        self.rejects(self.console, 'unsafe_process_executable')

    def test_every_uid_slot_must_match(self):
        path = self.proc / str(self.pid) / 'status'
        raw = path.read_bytes()
        for slot in range(4):
            uids = [str(self.uid)] * 4
            uids[slot] = str(self.uid + 1)
            self.write(path, raw.replace(f'Uid:\t{self.uid}\t{self.uid}\t{self.uid}\t{self.uid}'.encode(),
                                        ('Uid:\t' + '\t'.join(uids)).encode()))
            self.rejects(self.console, 'process_uid_mismatch')

    def test_status_pid_tgid_and_parent_are_cross_checked(self):
        path = self.proc / str(self.pid) / 'status'
        raw = path.read_bytes()
        for key in ('Pid', 'Tgid', 'PPid'):
            value = '1234' if key == 'PPid' else str(self.pid)
            self.write(path, raw.replace(f'{key}:\t{value}'.encode(), f'{key}:\t999'.encode()))
            self.rejects(self.console, 'process_identity_changed')

    def test_duplicate_status_fields_are_refused(self):
        path = self.proc / str(self.pid) / 'status'
        self.write(path, path.read_bytes() + b'Uid:\t0\t0\t0\t0\n')
        self.rejects(self.console, 'invalid_proc_status')

    def test_nonlive_process_states_are_refused(self):
        path = self.proc / str(self.pid) / 'stat'
        for state in ('Z', 'X', 'T', 't'):
            self.write(path, self.process_stat(self.pid, state=state))
            self.rejects(self.console, 'process_not_live')

    def test_comm_parentheses_and_whitespace_do_not_shift_starttime(self):
        path = self.proc / str(self.pid) / 'stat'
        self.write(path, self.process_stat(self.pid, comm='name ) (nested) \n name'))
        self.assertEqual(self.console()['start_ticks'], 123456)

    def test_starttime_change_during_snapshot_is_refused(self):
        read = m._read
        changed = False
        def altering(fd, name, limit):
            nonlocal changed
            raw = read(fd, name, limit)
            if name == 'stat' and not changed:
                changed = True
                self.write(self.proc / str(self.pid) / 'stat', self.process_stat(self.pid, start=123457))
            return raw
        with patch.object(m, '_read', side_effect=altering):
            self.rejects(self.console, 'process_identity_changed')

    def test_visible_pid_replacement_is_refused_even_with_identical_fields(self):
        read = m._read
        changed = False
        def altering(fd, name, limit):
            nonlocal changed
            raw = read(fd, name, limit)
            if name == 'stat' and not changed:
                changed = True
                (self.proc / str(self.pid)).rename(self.proc / 'original-task')
                self.process(self.pid, self.bun, command=self.command, cgroup=self.cgroup)
            return raw
        with patch.object(m, '_read', side_effect=altering):
            self.rejects(self.console, 'process_identity_changed')

    def test_proc_reads_are_bounded(self):
        self.write(self.proc / str(self.pid) / 'cmdline', b'x' * 32769)
        self.rejects(self.console, 'proc_file_too_large')

    def test_proc_symlink_and_fifo_are_refused_without_following(self):
        path = self.proc / str(self.pid) / 'cmdline'
        path.unlink()
        secret = self.write(self.base / 'secret', b'SYNTHETIC_PRIVATE')
        path.symlink_to(secret)
        self.rejects(self.console, 'managed_process_not_readable')
        path.unlink()
        os.mkfifo(path, 0o600)
        self.rejects(self.console, 'unsafe_proc_entry')

    def test_process_directory_symlink_is_refused(self):
        path = self.proc / str(self.pid)
        path.rename(self.proc / 'original-task')
        path.symlink_to(self.proc / 'original-task', target_is_directory=True)
        self.rejects(self.console, 'managed_process_not_readable')

    def test_process_pid_and_network_namespaces_must_match_verifier(self):
        for name in ('pid', 'net'):
            path = self.proc / str(self.pid) / 'ns' / name
            original = os.readlink(path)
            path.unlink()
            path.symlink_to(f'{name}:[999]')
            self.rejects(self.console, 'process_namespace_mismatch')
            path.unlink()
            path.symlink_to(original)

    def test_cgroup_requires_exact_single_unified_membership(self):
        path = self.proc / str(self.pid) / 'cgroup'
        for raw in (b'0::/other\n', ('1:name=systemd:' + self.cgroup + '\n').encode(),
                    ('0::' + self.cgroup + '\n0::/other\n').encode()):
            self.write(path, raw)
            self.rejects(self.console, 'process_cgroup_mismatch')

    def test_process_environment_is_never_opened(self):
        self.write(self.proc / str(self.pid) / 'environ', b'SYNTHETIC_PRIVATE_TOKEN=secret\0')
        opened = []
        real_open = os.open
        def recording(path, *args, **kwargs):
            opened.append(path)
            self.assertNotEqual(path, 'environ')
            self.assertNotEqual(path, 'mem')
            return real_open(path, *args, **kwargs)
        with patch.object(m.os, 'open', side_effect=recording):
            result = self.console()
        self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(result))
        self.assertTrue(opened)


class DatabaseProcessTests(ProcessFixture):
    def setUp(self):
        super().setUp()
        self.home = self.base / 'home'
        self.home.mkdir(mode=0o700)
        self.pins = {'postgres': {'revision': 'b' * 40, 'version': '18.6'},
                     'pgvector': {'revision': 'c' * 40}}
        self.prefix = 'postgres-18.6-' + 'b' * 12 + '-pgvector-' + 'c' * 12 + '-portable-v1'
        self.pg = self.home / 'runtime' / self.prefix / 'bin/postgres'
        self.write(self.pg, b'SYNTHETIC_POSTGRES_NOT_RUN').chmod(0o700)
        self.write(self.pg.parent.parent / '.ultrabrain-build', ('b' * 40 + ':' + 'c' * 40 + '\n').encode())
        self.data = self.home / 'postgres/data'
        self.write(self.data / 'PG_VERSION', b'18\n')
        self.state = {'port': 6543, 'app_password': 'SYNTHETIC_PRIVATE p/%',
                      'admin_password': 'SYNTHETIC_PRIVATE_ADMIN'}
        self.config = {'engine': 'postgres', 'database_url': 'postgresql://ultrabrain:' +
                       quote(self.state['app_password'], safe='') + '@127.0.0.1:6543/ultrabrain'}
        self.binding = {'version': '18.6', 'postgres_revision': 'b' * 40,
                        'pgvector_revision': 'c' * 40, 'directory': self.prefix}
        for name, value in (('postgres/state.json', self.state),
                            ('postgres/runtime.json', self.binding), ('gbrain/.gbrain/config.json', self.config)):
            self.write(self.home / name, json.dumps(value).encode())
        self.postmaster_pid, self.backend_pid = 424244, 424245
        self.started = 1789731000
        self.pidfile = self.data / 'postmaster.pid'
        self.pidlines = [str(self.postmaster_pid), str(self.data), str(self.started), '6543',
                         str(self.home / 'postgres/socket'), '127.0.0.1', '   54321 98765', 'ready   ']
        self.write(self.pidfile, ('\n'.join(self.pidlines) + '\n').encode())
        self.process(self.postmaster_pid, self.pg, cwd=self.data)
        self.process(self.backend_pid, self.pg, ppid=self.postmaster_pid, start=123457, cwd=self.data)

    def database(self):
        with m.PREFLIGHT.PrivateHome(self.home) as view:
            return m.database_snapshot(view, self.pins)

    def test_live_managed_database_and_backend_bind_without_credentials_in_result(self):
        before = self.database()
        self.assertEqual(before, self.database())
        self.assertEqual(before['postmaster_started'], self.started)
        self.assertEqual(before['postmaster']['pid'], self.postmaster_pid)
        self.assertEqual(before['data_directory_identity'][:2], [self.data.stat().st_dev, self.data.stat().st_ino])
        backend = m.verify_backend(before, self.backend_pid)
        self.assertEqual(backend['ppid'], self.postmaster_pid)
        self.assertEqual(backend, m.verify_backend(before, self.backend_pid))
        self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps([before, backend]))

    def test_managed_configuration_url_is_checked_without_network(self):
        changed = {**self.config, 'database_url': self.config['database_url'].replace('127.0.0.1', 'elsewhere.invalid')}
        self.write(self.home / 'gbrain/.gbrain/config.json', json.dumps(changed).encode())
        self.rejects(self.database, 'managed_database_mismatch')

    def test_runtime_pin_marker_and_cluster_major_bindings_are_required(self):
        alterations = [(self.home / 'postgres/runtime.json', json.dumps({**self.binding, 'directory': '../SYNTHETIC_PRIVATE'}).encode(), 'invalid_runtime_directory'),
                       (self.pg.parent.parent / '.ultrabrain-build', b'WRONG', 'runtime_build_marker_mismatch'),
                       (self.data / 'PG_VERSION', b'17\n', 'cluster_major_mismatch')]
        for path, raw, code in alterations:
            original = path.read_bytes()
            self.write(path, raw)
            self.rejects(self.database, code)
            self.write(path, original)

    def test_postmaster_file_fields_and_status_are_validated(self):
        for index, value, code in ((0, '-424244', 'invalid_postmaster_pid'),
                                   (0, '0', 'invalid_postmaster_pid'),
                                   (1, '/another/data', 'postmaster_data_directory_mismatch'),
                                   (2, '0', 'invalid_postmaster_start'),
                                   (3, '6544', 'postmaster_port_mismatch'),
                                   (4, 'relative/socket', 'invalid_postmaster_file'),
                                   (5, '*', 'postmaster_listen_address_mismatch'),
                                   (6, 'secret', 'invalid_postmaster_file'),
                                   (7, 'starting', 'postmaster_not_ready'),
                                   (7, 'stopping', 'postmaster_not_ready')):
            with self.subTest(index=index, value=value):
                lines = [*self.pidlines]
                lines[index] = value
                self.write(self.pidfile, ('\n'.join(lines) + '\n').encode())
                self.rejects(self.database, code)

    def test_postmaster_file_must_be_complete_bounded_private_and_not_linked(self):
        original = self.pidfile.read_bytes()
        for raw in (original[:-1], original + b'\n', original + b'\0', b'x' * 12289):
            self.write(self.pidfile, raw)
            self.rejects(self.database)
        self.write(self.pidfile, original).chmod(0o644)
        self.rejects(self.database, 'owner_only_permissions_required')
        self.pidfile.unlink()
        self.pidfile.symlink_to(self.write(self.home / 'other-pidfile', original))
        self.rejects(self.database, 'managed_process_not_readable')

    def test_unrelated_live_postmaster_cwd_is_refused_even_with_matching_pid_and_binary(self):
        other = self.home / 'other-cluster'
        other.mkdir(mode=0o700)
        cwd = self.proc / str(self.postmaster_pid) / 'cwd'
        cwd.unlink()
        cwd.symlink_to(other)
        self.rejects(self.database, 'postmaster_working_directory_mismatch')

    def test_matching_cwd_text_cannot_hide_different_open_directory_inode(self):
        other = self.home / 'other-cluster'
        other.mkdir(mode=0o700)
        cwd = self.proc / str(self.postmaster_pid) / 'cwd'
        cwd.unlink()
        cwd.symlink_to(other)
        readlink = os.readlink
        with patch.object(m.os, 'readlink', side_effect=lambda name, **kw:
                          str(self.data) if name == 'cwd' else readlink(name, **kw)):
            self.rejects(self.database, 'postmaster_working_directory_mismatch')

    def test_missing_postmaster_is_not_certified_from_pidfile(self):
        (self.proc / str(self.postmaster_pid)).rename(self.proc / 'dead-task')
        self.rejects(self.database, 'managed_process_not_readable')

    def test_postmaster_file_replaced_during_process_check_is_refused(self):
        snapshot = m._process_snapshot
        def replacing(*args, **kwargs):
            result = snapshot(*args, **kwargs)
            raw = self.pidfile.read_bytes()
            self.pidfile.rename(self.home / 'original-pidfile')
            self.write(self.pidfile, raw)
            return result
        with patch.object(m, '_process_snapshot', side_effect=replacing):
            self.rejects(self.database, 'managed_path_changed_during_check')

    def test_same_held_home_rejects_later_config_replacement(self):
        with m.PREFLIGHT.PrivateHome(self.home) as view:
            m.database_snapshot(view, self.pins)
            path = self.home / 'postgres/state.json'
            raw = path.read_bytes()
            path.rename(self.home / 'original-state')
            self.write(path, raw)
            self.rejects(lambda: m.database_snapshot(view, self.pins), 'managed_path_changed_during_check')

    def test_backend_must_be_child_of_selected_postmaster(self):
        database = self.database()
        directory = self.proc / str(self.backend_pid)
        self.write(directory / 'stat', self.process_stat(self.backend_pid, ppid=999, start=123457))
        path = directory / 'status'
        self.write(path, path.read_bytes().replace(f'PPid:\t{self.postmaster_pid}'.encode(), b'PPid:\t999'))
        self.rejects(lambda: m.verify_backend(database, self.backend_pid), 'backend_postmaster_mismatch')

    def test_backend_cannot_be_postmaster_or_preexist_it(self):
        database = self.database()
        self.rejects(lambda: m.verify_backend(database, self.postmaster_pid), 'backend_postmaster_mismatch')
        self.write(self.proc / str(self.backend_pid) / 'stat',
                   self.process_stat(self.backend_pid, ppid=self.postmaster_pid, start=123455))
        self.rejects(lambda: m.verify_backend(database, self.backend_pid), 'backend_postmaster_mismatch')

    def test_backend_requires_the_same_pinned_executable(self):
        database = self.database()
        path = self.proc / str(self.backend_pid) / 'exe'
        path.unlink()
        path.symlink_to(self.bun)
        self.rejects(lambda: m.verify_backend(database, self.backend_pid), 'process_executable_mismatch')

    def test_replacing_runtime_binary_after_database_snapshot_is_refused(self):
        database = self.database()
        self.pg.rename(self.pg.with_name('old-postgres'))
        self.write(self.pg, b'NEW_SYNTHETIC_POSTGRES').chmod(0o700)
        self.rejects(lambda: m.verify_backend(database, self.backend_pid), 'backend_runtime_mismatch')

    def test_backend_namespace_and_uid_must_match(self):
        database = self.database()
        self.rejects(lambda: m.verify_backend(database, self.backend_pid, uid=self.uid + 1), 'process_uid_mismatch')
        path = self.proc / str(self.backend_pid) / 'ns/net'
        path.unlink()
        path.symlink_to('net:[999]')
        self.rejects(lambda: m.verify_backend(database, self.backend_pid), 'process_namespace_mismatch')


class ActualProcReadTests(unittest.TestCase):
    @unittest.skipUnless(Path('/proc/self/stat').is_file(), 'Linux procfs required')
    def test_actual_current_process_stat_uid_and_namespaces_are_read_only(self):
        pid = os.getpid()
        with m._proc_directory(pid) as (fd, _):
            process = m._parse_stat(m._read(fd, 'stat', 8192), pid)
            m._parse_status(m._read(fd, 'status', 65536), process, os.geteuid())
            self.assertEqual(m._namespaces(fd), m._self_namespaces())
            self.assertGreater(process['start_ticks'], 0)

    @unittest.skipUnless(Path('/proc/self/exe').exists(), 'Linux procfs required')
    def test_actual_current_process_executable_link_matches_open_inode(self):
        executable = os.readlink('/proc/self/exe')
        # The test runner's runtime directory can be owned by another UID in a
        # container. Its trust policy is tested with controlled paths above;
        # this case checks the real proc magic-link/inode behavior only.
        executable_fd = os.open('/proc/self/exe', os.O_PATH)
        try:
            metadata = m.FS.metadata(os.fstat(executable_fd))
            with m._proc_directory(os.getpid()) as (fd, _):
                m._process_executable(fd, executable, metadata)
        finally:
            os.close(executable_fd)


if __name__ == '__main__':
    unittest.main()
