"""Small descriptor-bound filesystem helpers for personal-deploy.py.

This is a cooperative, same-account transaction, not isolation from another
process with the same UID. Names and identities are rechecked at every boundary.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat


class DeployError(Exception):
    pass


def need(condition, code):
    if not condition:
        raise DeployError(code)


def absolute(path):
    text = str(path)
    need(text.startswith('/') and text != '/' and len(text.encode()) <= 4096
         and not any(ord(c) < 32 or ord(c) == 127 for c in text)
         and all(p not in ('', '.', '..') for p in text.split('/')[1:]),
         'invalid_absolute_path')
    return Path(text)


def canonical(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True,
                       separators=(',', ':'))+'\n').encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def sha(value, optional=False):
    need(optional and value is None or isinstance(value, str)
         and re.fullmatch('[a-f0-9]{64}', value), 'invalid_digest')
    return value


def identity(st):
    # rename changes ctime; these fields survive moving our staging objects.
    return [st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid, st.st_nlink]


def metadata(st):
    return identity(st)+[st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def open_trusted_system_directory(path):
    """Read-only walk for the one supported distro compatibility alias."""
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in ('', *str(absolute(path)).split('/')[1:]):
            if part:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=fd)
                os.close(fd)
                fd = child
            value = os.fstat(fd)
            need(value.st_uid == 0 and not value.st_mode & 0o022,
                 'untrusted_system_unit_path')
        return fd
    except BaseException:
        os.close(fd)
        raise


def manager_scan_path(path):
    """Resolve only Ubuntu/Debian's root-controlled user-unit search alias.

    This never changes managed, state, export, or arbitrary load-path walks.
    Unit overrides are still inspected at the verified canonical directory.
    """
    path = absolute(path)
    if str(path) != '/etc/xdg/systemd/user':
        return path
    try:
        parent = open_trusted_system_directory('/etc/xdg/systemd')
    except FileNotFoundError:
        return path
    try:
        try:
            before = os.stat('user', dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return path
        if not stat.S_ISLNK(before.st_mode):
            return path
        need(before.st_uid == 0 and before.st_nlink == 1, 'untrusted_system_unit_alias')
        target = os.readlink('user', dir_fd=parent)
        need(target in ('../../systemd/user', '/etc/systemd/user'), 'untrusted_system_unit_alias')
        destination = open_trusted_system_directory('/etc/systemd/user')
        try:
            need(metadata(os.stat('user', dir_fd=parent, follow_symlinks=False)) == metadata(before),
                 'system_unit_alias_changed')
            visible = open_trusted_system_directory('/etc/xdg/systemd')
            try:
                need(identity(os.fstat(visible)) == identity(os.fstat(parent)),
                     'system_unit_alias_changed')
            finally:
                os.close(visible)
        finally:
            os.close(destination)
        return Path('/etc/systemd/user')
    finally:
        os.close(parent)


class Store:
    def __init__(self, uid):
        self.uid = uid

    def open_dir(self, path, *, create=False, private=False, owned=False):
        path = absolute(path)
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            parts = str(path).split('/')[1:]
            for index, part in enumerate(parts):
                try:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=fd)
                except FileNotFoundError:
                    if not create:
                        raise
                    need(os.fstat(fd).st_uid == self.uid, 'unsafe_directory_owner')
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                        os.fsync(fd)
                    except FileExistsError:
                        pass
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=fd)
                os.close(fd)
                fd = child
                st = os.fstat(fd)
                need(st.st_uid in (0, self.uid), 'unsafe_directory_owner')
                sticky_root = st.st_uid == 0 and bool(st.st_mode & stat.S_ISVTX)
                need(not st.st_mode & 0o022 or sticky_root, 'unsafe_directory_permissions')
                if index == len(parts)-1:
                    if owned or private:
                        need(st.st_uid == self.uid, 'unsafe_directory_owner')
                    if private:
                        need(not st.st_mode & 0o077, 'private_directory_required')
            return fd
        except BaseException:
            os.close(fd)
            raise

    @contextmanager
    def directory(self, path, **options):
        fd = self.open_dir(path, **options)
        try:
            yield fd
        finally:
            os.close(fd)

    def visible(self, fd, path):
        with self.directory(path) as current:
            need(identity(os.fstat(current)) == identity(os.fstat(fd)), 'directory_changed')

    def mkdir(self, path, *, exclusive=False):
        path = absolute(path)
        with self.directory(path.parent, owned=True) as parent:
            try:
                os.mkdir(path.name, 0o700, dir_fd=parent)
                os.fsync(parent)
            except FileExistsError:
                if exclusive:
                    raise DeployError('transaction_path_exists') from None
            self.visible(parent, path.parent)
        with self.directory(path, private=True):
            pass

    def regular(self, st):
        need(stat.S_ISREG(st.st_mode) and st.st_uid == self.uid and st.st_nlink == 1
             and not st.st_mode & 0o077, 'unsafe_state_file')

    def read(self, path, *, limit=524288, optional=False):
        path = absolute(path)
        try:
            with self.directory(path.parent, private=True) as parent:
                fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=parent)
                try:
                    before = os.fstat(fd)
                    self.regular(before)
                    need(before.st_size <= limit, 'state_file_too_large')
                    raw = bytearray()
                    while len(raw) <= limit:
                        chunk = os.read(fd, min(16384, limit+1-len(raw)))
                        if not chunk:
                            break
                        raw.extend(chunk)
                    need(len(raw) <= limit and metadata(os.fstat(fd)) == metadata(before),
                         'state_file_changed')
                    need(metadata(os.stat(path.name, dir_fd=parent, follow_symlinks=False))
                         == metadata(before), 'state_file_changed')
                    self.visible(parent, path.parent)
                    return bytes(raw), identity(before)
                finally:
                    os.close(fd)
        except FileNotFoundError:
            if optional:
                return None, None
            raise DeployError('state_file_missing') from None

    def read_json(self, path, *, limit=524288, optional=False):
        raw, ident = self.read(path, limit=limit, optional=optional)
        if raw is None:
            return None, None
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError):
            raise DeployError('invalid_state_json') from None
        need(isinstance(value, dict) and canonical(value) == raw, 'invalid_state_json')
        return value, ident

    def write_new(self, path, raw):
        path = absolute(path)
        with self.directory(path.parent, private=True) as parent:
            fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as output:
                    output.write(raw)
                    output.flush()
                    os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(parent)
            self.visible(parent, path.parent)

    def link(self, path):
        path = absolute(path)
        try:
            with self.directory(path.parent, owned=True) as parent:
                before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                need(stat.S_ISLNK(before.st_mode) and before.st_uid == self.uid
                     and before.st_nlink == 1, 'foreign_unit_file')
                target = os.readlink(path.name, dir_fd=parent)
                need(metadata(os.stat(path.name, dir_fd=parent, follow_symlinks=False))
                     == metadata(before), 'unit_link_changed')
                self.visible(parent, path.parent)
                return {'target': target, 'identity': identity(before)}
        except FileNotFoundError:
            return None

    def symlink_new(self, target, path):
        path = absolute(path)
        with self.directory(path.parent, private=True) as parent:
            os.symlink(str(target), path.name, dir_fd=parent)
            os.fsync(parent)
            self.visible(parent, path.parent)
        return self.link(path)

    def replace(self, source, target, *, absent_expected=False):
        source, target = absolute(source), absolute(target)
        with self.directory(source.parent, private=True) as src:
            with self.directory(target.parent, owned=True) as dst:
                self.visible(src, source.parent)
                self.visible(dst, target.parent)
                if absent_expected:
                    # Python exposes no rename flags. Linux renameat2 provides
                    # the required atomic no-replace guarantee for first install.
                    import ctypes
                    libc = ctypes.CDLL(None, use_errno=True)
                    rename = getattr(libc, 'renameat2', None)
                    need(rename is not None, 'atomic_noreplace_unavailable')
                    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                                       ctypes.c_char_p, ctypes.c_uint]
                    rename.restype = ctypes.c_int
                    if rename(src, os.fsencode(source.name), dst, os.fsencode(target.name), 1):
                        err = ctypes.get_errno()
                        raise OSError(err, 'atomic rename refused')
                else:
                    os.replace(source.name, target.name, src_dir_fd=src, dst_dir_fd=dst)
                os.fsync(dst)
                os.fsync(src)

    def remove(self, path):
        path = absolute(path)
        with self.directory(path.parent, owned=True) as parent:
            self.visible(parent, path.parent)
            os.unlink(path.name, dir_fd=parent)
            os.fsync(parent)

    def absent(self, path):
        path = absolute(path)
        try:
            with self.directory(path.parent) as parent:
                os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                self.visible(parent, path.parent)
                return False
        except FileNotFoundError:
            return True
