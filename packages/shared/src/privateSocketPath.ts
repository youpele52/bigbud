import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * Short, private Unix socket locations.
 *
 * `sockaddr_un.sun_path` is 104 bytes on macOS/BSD and 108 on Linux, including
 * the trailing NUL. Paths under a channel base dir
 * (`~/.bigbud/channels/<channel>/...`) plus a random run suffix exceed that, so
 * sockets that do not need a well-known location live under a short per-user
 * root instead: `/tmp/bigbud-<uid>/<prefix>-<scope tag>-<random>/<name>`.
 * The root is 0700, owned by the user and never a symlink; the scope tag is a
 * hash of the owning base dir so stable, beta and dev instances stay apart.
 */

const DEFAULT_TMP_ROOT = "/tmp";
const SCOPE_TAG_LENGTH = 12;

/** Longest socket path in bytes, excluding the trailing NUL. */
export function unixSocketPathMaxBytes(platform: NodeJS.Platform = process.platform): number {
  return platform === "linux" || platform === "android" ? 107 : 103;
}

export class UnixSocketPathTooLongError extends Error {
  override readonly name = "UnixSocketPathTooLongError";
}

/** Throw a clear error before `bind()` fails with an opaque SUN_LEN error. */
export function assertUnixSocketPathFits(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const bytes = Buffer.byteLength(socketPath);
  const max = unixSocketPathMaxBytes(platform);
  if (bytes > max) {
    throw new UnixSocketPathTooLongError(
      `Unix socket path is ${bytes} bytes but ${platform} allows at most ${max}: ${socketPath}`,
    );
  }
  return socketPath;
}

/** Stable short tag identifying the owner (for example a channel base dir). */
export function privateSocketScopeTag(scopeKey: string): string {
  return Crypto.createHash("sha256")
    .update(Path.resolve(scopeKey))
    .digest("hex")
    .slice(0, SCOPE_TAG_LENGTH);
}

export function privateSocketRootPath(uid: number, tmpRoot: string = DEFAULT_TMP_ROOT): string {
  return Path.join(tmpRoot, `bigbud-${uid}`);
}

function unsafeRoot(root: string, reason: string): Error {
  return new Error(`Refusing to use ${root} for private sockets: ${reason}.`);
}

/**
 * Create (or adopt) the per-user socket root. It must be a real directory
 * owned by `uid`; group/other permission bits are stripped. The parent must be
 * sticky or owned by `uid`, so no other user can swap the directory out.
 */
export function ensurePrivateSocketRoot(root: string, uid: number): void {
  const parent = FS.statSync(Path.dirname(root));
  if (parent.uid !== uid && (parent.mode & 0o1000) === 0) {
    throw unsafeRoot(root, "its parent is shared but not sticky");
  }
  try {
    FS.mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = FS.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw unsafeRoot(root, "it is not a real directory");
  }
  if (stat.uid !== uid) throw unsafeRoot(root, `it is owned by uid ${stat.uid}`);
  if ((stat.mode & 0o077) !== 0) {
    FS.chmodSync(root, 0o700);
    if ((FS.lstatSync(root).mode & 0o077) !== 0) {
      throw unsafeRoot(root, "its permissions could not be restricted to the owner");
    }
  }
}

export interface PrivateSocketDirectoryInput {
  /** Owner identity, typically the channel base dir; hashed into the directory name. */
  readonly scopeKey: string;
  /** Short purpose label, for example `cua`. */
  readonly prefix: string;
  readonly tmpRoot?: string;
  readonly uid?: number;
}

/** A fresh 0700 directory under the per-user root, unique per call. */
export function createPrivateSocketDirectory(input: PrivateSocketDirectoryInput): string {
  const uid = input.uid ?? process.getuid?.();
  if (uid === undefined) {
    throw new Error("Private Unix socket directories need a POSIX user ID.");
  }
  const root = privateSocketRootPath(uid, input.tmpRoot);
  ensurePrivateSocketRoot(root, uid);
  const directory = FS.mkdtempSync(
    Path.join(root, `${input.prefix}-${privateSocketScopeTag(input.scopeKey)}-`),
  );
  FS.chmodSync(directory, 0o700);
  return directory;
}
