"""Fixed E2 fixture recipe; no PTY and stdin must end after the raw payload.

/usr/bin/python3 -I -B -c <compiled source> ROOT REL OP EXPECTED ATTEMPTED SIZE

Only a qualified host and an owner-approved canonical root may be used. This
is not a dispatcher. Cooperating saves lock the resolved parent/leaf, and
also flock the target inode to serialize concurrent saves through hard links.
Neither lock fences external writers or an external directory move. In-place
publish can be partial; missing output never establishes remote termination.
"""

import errno
import fcntl
import hashlib
import os
import re
import stat
import sys

PREFIX = "BIGBUD_GUARDED_WRITE_V1"
CAP = 512 * 1024
COMPONENT = re.compile(r"[A-Za-z0-9._-]{1,255}")
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE = os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY
EVIDENCE = "operation"


class Refusal(Exception):
    """A bounded outcome before publication."""


class Uncertain(Exception):
    """Do not remove evidence."""


def components(path, *, fixture_root=False):
    result = path.split("/")
    # The generated dev workspace has one fixed display-name component.
    # This exception never applies to relative file paths.
    normal = (
        result[:-1]
        if fixture_root and result[-1] == "picker's folders; literal"
        else result
    )
    if len(path) > 4095 or not normal or any(
        not COMPONENT.fullmatch(part)
        or part in (".", "..")
        or part.lower().startswith(".bigbud-")
        for part in normal
    ):
        raise Refusal("terminal request")
    return result


def sha(data):
    return hashlib.sha256(data).hexdigest()


def text(data):
    if b"\0" in data:
        return False
    try:
        data.decode("utf-8")
    except UnicodeError:
        return False
    return True


def request():
    if len(sys.argv) != 7:
        raise Refusal("terminal request")
    root, relative, operation, expected, attempted, size = sys.argv[1:]
    if (
        not root.startswith("/")
        or not re.fullmatch(r"[0-9a-f]{32}", operation)
        or not all(re.fullmatch(r"[0-9a-f]{64}", d) for d in (expected, attempted))
        or not re.fullmatch(r"0|[1-9][0-9]{0,5}", size)
        or int(size) > CAP
    ):
        raise Refusal("terminal request")
    roots, parts = components(root[1:], fixture_root=True), components(relative)
    # A single bounded read requires exact byte count and EOF, before locking.
    data = sys.stdin.buffer.read(int(size) + 1)
    if len(data) != int(size) or sha(data) != attempted or not text(data):
        raise Refusal("terminal request")
    return roots, parts, operation, expected, attempted, data


def walk(fd, parts, missing):
    for part in parts:
        try:
            child = os.open(part, DIRECTORY, dir_fd=fd)
        except FileNotFoundError:
            raise Refusal(missing) from None
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                raise Refusal("terminal scope") from None
            raise
        finally:
            os.close(fd)
        fd = child
    return fd


def at(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None


def identity(info):
    return None if info is None else (info.st_dev, info.st_ino)


def attributes(info):
    return info.st_mode, info.st_uid, info.st_gid, info.st_nlink


def version(info):
    return (
        identity(info),
        attributes(info),
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def read_file(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    with os.fdopen(os.dup(fd), "rb") as stream:
        return stream.read(CAP + 1)


def write_file(fd, data, mode=None):
    with os.fdopen(os.dup(fd), "wb") as stream:
        stream.write(data)
    if mode is not None:
        os.fchmod(fd, mode)
    os.fsync(fd)


def metadata(fd):
    """Return whether replacement would lose metadata, or refuse the host/type."""
    if sys.platform == "linux":
        names = os.listxattr(fd)
        if any(
            n != "system.posix_acl_access" and not n.startswith("user.") for n in names
        ):
            raise Refusal("terminal target")
        return bool(names)
    if sys.platform == "darwin":
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        libc.flistxattr.argtypes = [
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_int,
        ]
        libc.flistxattr.restype = ctypes.c_ssize_t
        libc.acl_get_fd_np.argtypes = [ctypes.c_int, ctypes.c_int]
        libc.acl_get_fd_np.restype = ctypes.c_void_p
        libc.acl_free.argtypes = [ctypes.c_void_p]
        size = libc.flistxattr(fd, None, 0, 0)
        if size < 0:
            raise Refusal("terminal hostToolUnavailable")
        acl = libc.acl_get_fd_np(fd, 0x100)  # ACL_TYPE_EXTENDED
        if acl:
            if libc.acl_free(acl) != 0:
                raise Refusal("terminal hostToolUnavailable")
            return True
        if ctypes.get_errno() != errno.ENOENT:
            raise Refusal("terminal hostToolUnavailable")
        return size > 0
    raise Refusal("terminal hostToolUnavailable")


class Guard:
    def __init__(self, parent, leaf, operation):
        self.parent = parent
        # Case variants must share a lock on case-insensitive filesystems.
        self.lock = ".bigbud-lock-" + sha(leaf.lower().encode("ascii"))
        self.stage = ".bigbud-edit-" + operation
        self.lock_fd = self.stage_fd = self.evidence_fd = None
        self.publishing = False

    def acquire(self, operation, attempted):
        try:
            os.mkdir(self.lock, 0o700, dir_fd=self.parent)
        except FileExistsError:
            # Never inspect age or ID as permission to reclaim an existing lock.
            raise Refusal("terminal busy") from None
        try:
            self.lock_fd = os.open(self.lock, DIRECTORY, dir_fd=self.parent)
            self.evidence_fd = os.open(
                EVIDENCE,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE,
                0o600,
                dir_fd=self.lock_fd,
            )
            write_file(
                self.evidence_fd, (operation + " " + attempted + "\n").encode("ascii")
            )
            os.fsync(self.lock_fd)
            os.fsync(self.parent)
        except OSError:
            raise Uncertain from None
        if at(self.parent, self.stage) is not None:
            raise Uncertain

    def create_stage(self):
        try:
            self.stage_fd = os.open(
                self.stage,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | FILE,
                0o600,
                dir_fd=self.parent,
            )
        except FileExistsError:
            raise Uncertain from None

    def verify(self):
        for fd, parent, name in (
            (self.lock_fd, self.parent, self.lock),
            (self.evidence_fd, self.lock_fd, EVIDENCE),
            (self.stage_fd, self.parent, self.stage),
        ):
            if fd is not None and identity(at(parent, name)) != identity(os.fstat(fd)):
                raise Uncertain

    def clean(self):
        if self.lock_fd is None:
            return
        self.verify()
        if self.stage_fd is not None:
            os.unlink(self.stage, dir_fd=self.parent)
        os.unlink(EVIDENCE, dir_fd=self.lock_fd)
        os.rmdir(self.lock, dir_fd=self.parent)
        os.fsync(self.parent)


def checked_bytes(parent, leaf, fd, before, expected):
    current = at(parent, leaf)
    if current is None:
        raise Refusal("conflict missing")
    if identity(current) != identity(before):
        raise Refusal("conflict changed")
    snapshot = os.fstat(fd)
    data = read_file(fd)
    if len(data) > CAP:
        raise Refusal("terminal target")
    digest = sha(data)
    is_text = text(data)
    current = at(parent, leaf)
    if current is None:
        raise Refusal("conflict missing")
    if version(snapshot) != version(current):
        raise Refusal("conflict changed")
    if digest != expected:
        raise Refusal("conflict " + digest)
    if version(before) != version(snapshot):
        raise Refusal("conflict changed")
    if not is_text:
        raise Refusal("terminal target")


def save(guard, roots, parts, leaf, expected, attempted, data):
    parent = guard.parent
    initial = at(parent, leaf)
    if initial is None:
        raise Refusal("conflict missing")
    if not stat.S_ISREG(initial.st_mode):
        raise Refusal("terminal target")
    target = os.open(leaf, os.O_RDWR | FILE, dir_fd=parent)
    before = os.fstat(target)
    mode = stat.S_IMODE(before.st_mode)
    if identity(initial) != identity(before):
        raise Refusal("conflict changed")
    if mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX) or getattr(
        before, "st_flags", 0
    ):
        raise Refusal("terminal target")
    try:
        fcntl.flock(target, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Refusal("terminal busy") from None
    checked_bytes(parent, leaf, target, before, expected)
    has_metadata = metadata(target)
    guard.create_stage()
    staged = guard.stage_fd
    stage_info = os.fstat(staged)
    in_place = (
        has_metadata
        or before.st_nlink != 1
        or before.st_uid != os.geteuid()
        or before.st_gid != os.getegid()
        or before.st_uid != stage_info.st_uid
        or before.st_gid != stage_info.st_gid
        or metadata(staged)
    )
    if not in_place:
        fcntl.flock(staged, fcntl.LOCK_EX | fcntl.LOCK_NB)
    write_file(staged, data, None if in_place else mode)
    staged_version = os.fstat(staged)
    if sha(read_file(staged)) != attempted:
        raise Uncertain
    os.fsync(parent)
    # Detect prior scope moves. No shell recipe can make a namespace check
    # and publication indivisible against an external directory rename.
    resolved = walk(os.open("/", DIRECTORY), roots + parts[:-1], "conflict missing")
    try:
        if identity(os.fstat(resolved)) != identity(os.fstat(parent)):
            raise Refusal("conflict changed")
    finally:
        os.close(resolved)
    guard.verify()
    checked_bytes(parent, leaf, target, before, expected)
    guard.verify()
    if version(os.fstat(staged)) != version(staged_version):
        raise Uncertain
    guard.publishing = True
    if in_place:
        os.ftruncate(target, 0)
        os.lseek(target, 0, os.SEEK_SET)
        write_file(target, data)
        published, intended = target, before
    else:
        intended = os.fstat(staged)
        os.replace(guard.stage, leaf, src_dir_fd=parent, dst_dir_fd=parent)
        guard.stage_fd = None  # Consumed by rename; leave the lock on uncertainty.
        published = staged
    os.fsync(parent)
    after = os.fstat(published)
    if (
        identity(after) != identity(intended)
        or attributes(after) != attributes(intended)
        or sha(read_file(published)) != attempted
        or (current := at(parent, leaf)) is None
        or version(after) != version(current)
    ):
        raise Uncertain
    return f"saved {'inPlace' if in_place else 'atomic'} {attempted}"


def run():
    guard = None
    try:
        # Qualify the fixed interpreter before consuming stdin or touching the
        # workspace. No alternate tool, command, or write method is attempted.
        if (
            sys.version_info < (3, 8)
            or sys.platform not in ("darwin", "linux")
            or not {os.open, os.stat, os.mkdir, os.unlink, os.rename, os.rmdir}
            <= os.supports_dir_fd
            or os.stat not in os.supports_follow_symlinks
            or (sys.platform == "linux" and not hasattr(os, "listxattr"))
        ):
            raise Refusal("terminal hostToolUnavailable")
        roots, parts, operation, expected, attempted, data = request()
        root = walk(os.open("/", DIRECTORY), roots, "terminal scope")
        parent = walk(root, parts[:-1], "conflict missing")
        leaf = parts[-1]
        guard = Guard(parent, leaf, operation)
        guard.acquire(operation, attempted)
        result = save(guard, roots, parts, leaf, expected, attempted, data)
    except Uncertain:
        return "unknown"
    except (Refusal, OSError) as error:
        if guard is not None and guard.publishing:
            return "unknown"
        result = error.args[0] if isinstance(error, Refusal) else "terminal io"
    try:
        if guard is not None:
            guard.clean()
    except (Uncertain, OSError):
        return "unknown"
    return result


if __name__ == "__main__":
    os.umask(0o077)
    print(PREFIX, run(), flush=True)
