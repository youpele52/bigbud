/** Unix descriptor-relative file broker, not a shell or an OS process sandbox. Python runs -I -S. */
export const V2_FILE_WORKER = String.raw`
import os, sys, json, stat, hashlib, secrets, ast
MAX = 131072
def digest(data): return hashlib.sha256(data).hexdigest()
def inspect(fd, count, depth=0):
    if depth > 64: raise ValueError("command workspace depth exceeds bound")
    with os.scandir(fd) as entries:
        for entry in entries:
            count[0] += 1
            if count[0] > 25000: raise ValueError("command workspace inspection exceeds bound")
            info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode): continue
            if stat.S_ISDIR(info.st_mode):
                child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try: inspect(child, count, depth+1)
                finally: os.close(child)
            elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("command workspace contains a nonregular/multi-link file")
def read(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX:
        raise ValueError("regular single-link bounded text file required")
    data = b""
    while len(data) <= MAX:
        chunk = os.read(fd, min(8192, MAX + 1 - len(data)))
        if not chunk: break
        data += chunk
    if len(data) > MAX: raise ValueError("file exceeds bound")
    data.decode("utf-8")
    return data
def main():
    request = json.loads(sys.stdin.buffer.read(MAX * 8))
    root = os.open(request["root"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        identity = os.fstat(root)
        if [identity.st_dev, identity.st_ino] != request["identity"]: raise ValueError("workspace root changed")
        if request["action"] == "inspect":
            if request["path"] != ".": raise ValueError("command inspection requires bound root")
            count = [0]; inspect(root, count)
            return {"content": "command workspace inode inventory validated"}
        path = request["path"]
        if path == "." and request["action"] in ("list", "probe"): parts = []
        else:
            parts = path.split("/")
            if not parts or len(parts) > 64 or any(p in ("", ".", "..") or "\x00" in p for p in parts) or path.startswith("/"):
                raise ValueError("relative canonical path required")
        if any(p in (".git", ".bigbud") for p in parts): raise ValueError("protected workspace metadata")
        if request["action"] in ("write", "edit") and any(p in (".opencode", ".agents") for p in parts):
            raise ValueError("plugin/skill configuration mutation unavailable")
        parent = os.dup(root)
        try:
            walk = parts if request["action"] == "list" else parts[:-1]
            for part in walk:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent); parent = child
            if request["action"] == "list":
                entries = os.listdir(parent)
                if len(entries) > 1000: raise ValueError("directory exceeds bound")
                return {"entries": sorted(entries)}
            if not parts and request["action"] == "probe": return {"content": "directory validated"}
            leaf = parts[-1]
            original = None
            mode = 0o600
            try:
                fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    if request["action"] == "probe":
                        info = os.fstat(fd)
                        if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode): raise ValueError("regular file/directory required")
                        return {"content": "target validated"}
                    original = read(fd)
                    mode = os.fstat(fd).st_mode & 0o777
                finally: os.close(fd)
            except FileNotFoundError:
                if request["action"] != "write": raise
            if request["action"] in ("read", "skill"):
                return {"content": original.decode("utf-8"), "sha256": digest(original)}
            if request["action"] == "check":
                if not path.endswith(".py"): raise ValueError("only Python syntax validation supported")
                ast.parse(original.decode("utf-8"), filename=path)
                return {"content": "Python syntax valid; no code was executed", "sha256": digest(original)}
            if request["action"] not in ("write", "edit"): raise ValueError("unsupported action")
            actual = digest(original) if original is not None else None
            if actual != request["expectedSha256"]: raise ValueError("file changed since approval")
            data = request["content"].encode("utf-8")
            if len(data) > MAX: raise ValueError("write exceeds bound")
            temporary = ".bigbud-code-" + secrets.token_hex(16)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, "wb") as output:
                    os.fchmod(output.fileno(), mode)
                    output.write(data); output.flush(); os.fsync(output.fileno())
                if original is not None:
                    current = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                    try:
                        if digest(read(current)) != actual: raise ValueError("file changed before replacement")
                    finally: os.close(current)
                    os.rename(temporary, leaf, src_dir_fd=parent, dst_dir_fd=parent)
                else:
                    os.link(temporary, leaf, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                    os.unlink(temporary, dir_fd=parent)
                os.fsync(parent)
            finally:
                try: os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError: pass
            return {"content": "File updated", "sha256": digest(data)}
        finally: os.close(parent)
    finally: os.close(root)
try:
    print(json.dumps({"ok": True, "result": main()}))
except Exception as error:
    print(json.dumps({"ok": False, "error": str(error)}))
`;
