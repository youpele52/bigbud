import { spawnSync } from "node:child_process";
import type { ClosureEntry } from "./closure.ts";

// Python's stdlib supplies portable tar/PAX and deterministic gzip headers without adding
// a production dependency. No downloaded code or package lifecycle script is executed.
const program = String.raw`
import gzip, json, os, pathlib, shutil, stat, sys, tarfile, zlib

request = json.load(sys.stdin)
entries = request['entries']
archive = request['archive']
if len(entries) > 100000:
    raise ValueError('Archive entry budget exceeded')
expected = {e['path']: e for e in entries}
if len(expected) != len(entries):
    raise ValueError('Duplicate inventory path')
if sum(e.get('size', 0) for e in entries) > 4 * 1024 ** 3:
    raise ValueError('Archive byte budget exceeded')

class BoundedReader:
    # Reject oversized extension-header allocations before tarfile parses them.
    def __init__(self, stream): self.stream = stream
    def tell(self): return self.stream.tell()
    def read(self, size):
        if size < 0 or size > 8 * 1024 ** 2:
            raise ValueError('Archive read budget exceeded')
        if self.tell() + size > 4 * 1024 ** 3 + 100000 * 4096:
            raise ValueError('Archive expansion budget exceeded')
        return self.stream.read(size)
    def seek(self, offset, whence=0):
        position = offset + (self.tell() if whence == 1 else 0)
        if whence not in (0, 1) or position < 0 or position > 4 * 1024 ** 3 + 100000 * 4096:
            raise ValueError('Archive seek budget exceeded')
        return self.stream.seek(position)

def valid_path(name):
    p = pathlib.PurePosixPath(name)
    return (name and not p.is_absolute() and str(p) == name and
            all(part not in ('', '.', '..') for part in p.parts) and
            '\\' not in name and ':' not in name and not any(ord(c) < 32 or ord(c) == 127 for c in name))

for e in entries:
    if not valid_path(e['path']):
        raise ValueError('Unsafe inventory path')
    for ancestor in pathlib.PurePosixPath(e['path']).parents:
        if str(ancestor) != '.' and expected.get(str(ancestor), {}).get('kind') != 'directory':
            raise ValueError('Missing or non-directory ancestor')
    if e['kind'] == 'symlink':
        target = e['target']
        if not target or target.startswith('/') or '\\' in target or ':' in target or any(ord(c) < 32 or ord(c) == 127 for c in target):
            raise ValueError('Unsafe symlink target')
        resolved = os.path.normpath(str(pathlib.PurePosixPath(e['path']).parent / target))
        if resolved not in expected or resolved == '..' or resolved.startswith('../'):
            raise ValueError('Symlink target outside closure')

if request['action'] == 'create':
    with open(archive, 'xb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=6) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as tar:
            for e in entries:
                member = tarfile.TarInfo(e['path'])
                member.uid = member.gid = member.mtime = 0
                member.uname = member.gname = ''
                member.mode = e['mode']
                if e['kind'] == 'directory':
                    member.type = tarfile.DIRTYPE
                    tar.addfile(member)
                elif e['kind'] == 'symlink':
                    member.type = tarfile.SYMTYPE
                    member.linkname = e['target']
                    tar.addfile(member)
                else:
                    member.size = e['size']
                    fd = os.open(e['source'], os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(fd, 'rb') as source:
                        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode) or os.fstat(source.fileno()).st_size != e['size']:
                            raise ValueError('Source changed during packaging')
                        tar.addfile(member, source)
elif request['action'] == 'extract':
    destination = pathlib.Path(request['destination'])
    destination.mkdir(mode=0o700)
    with gzip.open(archive, 'rb') as compressed, tarfile.open(fileobj=BoundedReader(compressed), mode='r:') as tar:
        # Bound the header walk before reading payloads; never call extractall.
        seen = {}
        for member in tar:
            if len(seen) >= 100000 or not valid_path(member.name) or member.name in seen:
                raise ValueError('Unsafe or duplicate archive member')
            seen[member.name] = member
            e = expected.get(member.name)
            if not e or member.mode != e['mode'] or member.uid != 0 or member.gid != 0 or member.mtime != 0:
                raise ValueError('Archive metadata differs from inventory')
            kind = e['kind']
            if not ((kind == 'file' and member.isfile()) or (kind == 'directory' and member.isdir()) or (kind == 'symlink' and member.issym())):
                raise ValueError('Unsupported archive member type')
            if kind == 'file' and member.size != e['size']:
                raise ValueError('Archive size differs from inventory')
            if kind != 'file' and member.size != 0:
                raise ValueError('Unexpected non-file payload')
            if kind == 'symlink' and member.linkname != e['target']:
                raise ValueError('Archive link differs from inventory')
        if set(seen) != set(expected):
            raise ValueError('Archive closure differs from inventory')
        # Create links last, so no extraction write can follow a link.
        for e in entries:
            out = destination / e['path']
            if e['kind'] == 'directory':
                out.mkdir(mode=e['mode'])
                os.chmod(out, e['mode'])
            elif e['kind'] == 'file':
                with tar.extractfile(seen[e['path']]) as source, open(out, 'xb') as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
                os.chmod(out, e['mode'])
        for e in entries:
            if e['kind'] == 'symlink':
                (destination / e['path']).symlink_to(e['target'])
else:
    raise ValueError('Unknown archive action')
print(json.dumps({'python': sys.version.split()[0], 'zlib': zlib.ZLIB_VERSION}))
`;

export function runArchive(input: {
  action: "create" | "extract";
  entries: readonly ClosureEntry[];
  archive: string;
  destination?: string;
}): { python: string; zlib: string } {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", program], {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    timeout: 10 * 60 * 1000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Experimental archive ${input.action} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout) as { python: string; zlib: string };
}
