"""Fixed exclusive-create recipe for the private owner fixture.

Invoke as /usr/bin/python3 -I -B -c <source> ROOT REL SIZE with raw stdin.
The caller must bind ROOT to the selected fixture. The parent must already
exist. Descriptor-relative operations reject symlink traversal but do not
fence an external move of the opened parent or a hostile directory writer.
"""

import errno
import os
import re
import secrets
import sys
from collections.abc import Sequence
from contextlib import contextmanager
from typing import BinaryIO, Generator

CAP = 48 * 1024
PREFIX = "BIGBUD_WORKSPACE_CREATE_V1"
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def components(path: str) -> list[str]:
    parts = path.split("/")
    if (
        len(os.fsencode(path)) > 4095
        or any(part in ("", ".", "..") for part in parts)
        or "\0" in path
    ):
        raise ValueError("invalid path")
    return parts


@contextmanager
def open_parent(parts: list[str]) -> Generator[int, None, None]:
    fd = os.open("/", DIRECTORY)
    try:
        for part in parts:
            child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def publish(parent: int, leaf: str, data: bytes) -> str:
    # Use disjoint prefixes so staging cannot publish directly to the leaf,
    # including on case-insensitive filesystems.
    prefix = ".bigbud-create." if leaf.startswith("._") else "._bigbud-create."
    stage = prefix + secrets.token_hex(16)
    fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            # link(2) never follows or replaces the destination name. Unlike
            # the ln utility, it cannot interpret a directory leaf as a container.
            os.link(
                stage, leaf, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False
            )
        except FileExistsError:
            return "alreadyExists"
        return "created"
    finally:
        os.unlink(stage, dir_fd=parent)


def run(args: Sequence[str], stdin: BinaryIO) -> str:
    if len(args) != 3:
        return "invalidRequest"
    root, relative, size = args
    if not root.startswith("/") or not re.fullmatch(r"0|[1-9][0-9]{0,4}", size):
        return "invalidRequest"
    count = int(size)
    if count > CAP:
        return "invalidRequest"
    try:
        roots, parts = components(root[1:]), components(relative)
    except ValueError:
        return "invalidRequest"
    data = stdin.read(count + 1)
    if len(data) != count:
        return "invalidRequest"

    # An error once the parent is open may occur after publication or during
    # cleanup. Do not turn it into a negative acknowledgement or invite retry.
    entered_parent = False
    try:
        with open_parent(roots + parts[:-1]) as parent:
            entered_parent = True
            return publish(parent, parts[-1], data)
    except OSError as error:
        if not entered_parent and error.errno in (
            errno.ENOENT,
            errno.ENOTDIR,
            errno.ELOOP,
            errno.EACCES,
            errno.EPERM,
        ):
            return "pathDenied"
        raise


def main() -> int:
    try:
        outcome = run(sys.argv[1:], sys.stdin.buffer)
        print(f"{PREFIX} {outcome}", flush=True)
    except OSError:
        # Missing marker is unknown; never replay an unconfirmed create.
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
