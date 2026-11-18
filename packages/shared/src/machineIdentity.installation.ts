/**
 * Persisted random installation id: the fallback host identity for machines without a platform
 * machine id (containers usually have no `/etc/machine-id`).
 *
 * The id is minted once (256 random bits) into `<baseDir>/identity/installation-v1` and then only
 * read. The directory must be a real 0700 directory and the file a real 0600 regular file, both
 * owned by this user; symlinks are never followed. The file is created atomically: an `O_EXCL`
 * temp file is fully written and synced, then hard-linked into place, which (unlike `rename`)
 * never replaces an id another process published first. Every racer then reads the one winner.
 *
 * A file that exists but is unreadable, corrupt, too permissive or a symlink is refused, never
 * replaced: minting a new id would make every earlier controller of this installation look
 * foreign. The caller gets a reason that names the file to repair.
 *
 * The id lives in the account's bigbud home, so it is per account, not per host. Two hosts sharing
 * that home (for example over NFS) would read the same id; `localHostIdentity` therefore binds the
 * hostname into the derived identity.
 *
 * @module machineIdentity.installation
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

const DIRECTORY = "identity";
const FILE = "installation-v1";
const FORMAT = /^[0-9a-f]{64}\n$/;
const MAX_BYTES = 128;

export type InstallationIdResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: string };

export function installationIdPath(baseDir: string): string {
  return path.join(baseDir, DIRECTORY, FILE);
}

function code(cause: unknown): string | undefined {
  return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function privateOwner(stat: fs.Stats): boolean {
  const uid = process.getuid?.();
  return (uid === undefined || stat.uid === uid) && (stat.mode & 0o077) === 0;
}

function ensureDirectory(directory: string): string | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(directory);
    } catch (cause) {
      if (code(cause) !== "ENOENT") return `cannot inspect ${directory}: ${describe(cause)}`;
      try {
        fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (mkdirCause) {
        if (code(mkdirCause) !== "EEXIST") {
          return `cannot create ${directory}: ${describe(mkdirCause)}`;
        }
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return `${directory} is not a real directory (symlinks are refused)`;
    }
    if (!privateOwner(stat)) return `${directory} must be owned by this user with mode 0700`;
    return undefined;
  }
  return `${directory} keeps changing while it is created`;
}

type ReadResult =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly reason: string };

function readExisting(file: string): ReadResult {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (cause) {
    if (code(cause) === "ENOENT") return { kind: "missing" };
    if (code(cause) === "ELOOP") return { kind: "refused", reason: `${file} is a symlink` };
    return { kind: "refused", reason: `${file} is unreadable: ${describe(cause)}` };
  }
  try {
    const stat = fs.fstatSync(fd);
    // No link-count check: a racer's publish briefly shares the inode with its temp name.
    if (!stat.isFile()) return { kind: "refused", reason: `${file} is not a regular file` };
    if (!privateOwner(stat)) {
      return { kind: "refused", reason: `${file} must be owned by this user with mode 0600` };
    }
    if (stat.size > MAX_BYTES) return { kind: "refused", reason: `${file} is corrupt` };
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, length).toString("utf8");
    if (!FORMAT.test(text)) return { kind: "refused", reason: `${file} is corrupt` };
    return { kind: "id", id: text.slice(0, 64) };
  } catch (cause) {
    return { kind: "refused", reason: `${file} is unreadable: ${describe(cause)}` };
  } finally {
    fs.closeSync(fd);
  }
}

function publish(directory: string, file: string): string | undefined {
  const temp = path.join(directory, `.${FILE}.${randomBytes(8).toString("hex")}.tmp`);
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  try {
    const fd = fs.openSync(temp, flags, 0o600);
    try {
      fs.writeSync(fd, `${randomBytes(32).toString("hex")}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temp, file);
    } catch (cause) {
      // Another process published first; its id wins and is read back below.
      if (code(cause) !== "EEXIST") return `cannot create ${file}: ${describe(cause)}`;
    }
    syncDirectory(directory);
    return undefined;
  } catch (cause) {
    return `cannot create ${file}: ${describe(cause)}`;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function syncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Durability hint only; the link itself is already atomic.
  }
}

/** Read the installation id under `baseDir`, minting it only when no file exists yet. */
export function readOrCreateInstallationId(baseDir: string): InstallationIdResult {
  if (process.platform === "win32") {
    return { ok: false, reason: "private file modes cannot be verified on Windows" };
  }
  const file = installationIdPath(baseDir);
  const directory = path.dirname(file);
  const directoryIssue = ensureDirectory(directory);
  if (directoryIssue) return { ok: false, reason: directoryIssue };
  const first = readExisting(file);
  if (first.kind === "id") return { ok: true, id: first.id };
  if (first.kind === "refused") return { ok: false, reason: first.reason };
  const publishIssue = publish(directory, file);
  if (publishIssue) return { ok: false, reason: publishIssue };
  const second = readExisting(file);
  if (second.kind === "id") return { ok: true, id: second.id };
  return {
    ok: false,
    reason: second.kind === "refused" ? second.reason : `${file} vanished after creation`,
  };
}
