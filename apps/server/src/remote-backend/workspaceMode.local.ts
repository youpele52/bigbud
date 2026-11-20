/**
 * Local workspace-mode store: the remote backend reserves folders on its own host here, in the
 * same `~/.bigbud/workspace-modes/` layout the SSH shell store uses, so both sides contend on
 * one file set. Directories are private (0700) and never symlinks; generation files are 0600,
 * opened with O_NOFOLLOW and published by hard-linking a complete, flushed temp file
 * (exclusive: EEXIST means another writer won the generation).
 *
 * @module workspaceMode.local
 */
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { machineIdentity } from "@bigbud/shared/machineIdentity";

import {
  decodeWorkspaceModeRecord,
  encodeWorkspaceModeRecord,
  MAX_WORKSPACE_MODE_RECORD_BYTES,
  sha256Hex,
  WORKSPACE_MODE_DIRECTORY,
  workspaceModeKey,
  type WorkspaceModeIdentity,
  type WorkspaceModeInspection,
  type WorkspaceModeRecord,
  type WorkspaceModeStore,
} from "./workspaceMode.record.ts";

const GENERATION_FILE = /^([1-9][0-9]{0,15})\.json$/;
const RETRIES = 4;

const errorCode = (cause: unknown) =>
  cause instanceof Error && "code" in cause ? String(cause.code) : undefined;

class UnsafeWorkspaceModePath extends Error {}

function assertPrivate(stats: Stats, uid: number, kind: "dir" | "file", where: string) {
  const ok =
    !stats.isSymbolicLink() &&
    (kind === "dir" ? stats.isDirectory() : stats.isFile()) &&
    stats.uid === uid &&
    (stats.mode & 0o777) === (kind === "dir" ? 0o700 : 0o600);
  if (!ok)
    throw new UnsafeWorkspaceModePath(
      `Workspace mode storage '${where}' must be a private ${kind === "dir" ? "directory (0700)" : "file (0600)"} owned by this account and not a symlink.`,
    );
}

async function ensureDirectory(dir: string, uid: number, requirePrivate: boolean) {
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") throw cause;
  }
  const stats = await fs.lstat(dir);
  if (requirePrivate) return assertPrivate(stats, uid, "dir", dir);
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== uid)
    throw new UnsafeWorkspaceModePath(
      `'${dir}' must be a directory owned by this account and not a symlink.`,
    );
}

async function readPrivateFile(file: string, uid: number): Promise<string | undefined> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  }
  try {
    const stats = await handle.stat();
    assertPrivate(stats, uid, "file", file);
    if (stats.size > MAX_WORKSPACE_MODE_RECORD_BYTES)
      throw new UnsafeWorkspaceModePath(`Workspace mode record '${file}' is too large.`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function generations(dir: string): Promise<number[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return [];
    throw cause;
  }
  return names
    .map((name) => GENERATION_FILE.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .toSorted((a, b) => b - a);
}

export interface LocalWorkspaceModeStoreOptions {
  readonly home?: string;
  readonly hostIdentity?: string | null;
  readonly accountUid?: number;
}

export function makeLocalWorkspaceModeStore(
  options: LocalWorkspaceModeStoreOptions = {},
): WorkspaceModeStore {
  const home = options.home ?? os.homedir();
  const hostIdentity =
    options.hostIdentity === undefined ? machineIdentity() : options.hostIdentity;
  const uid = options.accountUid ?? process.getuid?.();
  const bigbud = path.join(home, ".bigbud");
  const root = path.join(bigbud, WORKSPACE_MODE_DIRECTORY);

  const reservationDir = async (key: string) => {
    await ensureDirectory(bigbud, uid!, false);
    await ensureDirectory(root, uid!, true);
    const dir = path.join(root, key);
    await ensureDirectory(dir, uid!, true);
    return dir;
  };

  const readCurrent = async (identity: WorkspaceModeIdentity) => {
    const dir = await reservationDir(workspaceModeKey(identity));
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const [latest] = await generations(dir);
      if (latest === undefined) return null;
      const raw = await readPrivateFile(path.join(dir, `${latest}.json`), uid!);
      if (raw === undefined) continue; // Pruned between listing and reading; list again.
      const record = decodeWorkspaceModeRecord(raw);
      if (record.generation !== latest)
        throw new UnsafeWorkspaceModePath(
          `Workspace mode record ${latest} names another generation.`,
        );
      return record;
    }
    throw new Error("Workspace mode records changed too quickly to read.");
  };

  return {
    inspect: async (workspaceRoot): Promise<WorkspaceModeInspection> => {
      if (!hostIdentity) return { kind: "unsupported", reason: "no stable machine identity" };
      if (uid === undefined) return { kind: "unsupported", reason: "no POSIX account" };
      const real = await fs.realpath(workspaceRoot);
      if (!(await fs.stat(real)).isDirectory())
        throw new Error(`'${workspaceRoot}' is not a folder.`);
      const identity = { hostIdentity, accountUid: uid, realpathSha256: sha256Hex(real) };
      return { kind: "ready", identity, current: await readCurrent(identity) };
    },
    publish: async (next: WorkspaceModeRecord) => {
      const content = encodeWorkspaceModeRecord(next);
      const dir = await reservationDir(workspaceModeKey(next));
      const temp = path.join(dir, `.tmp.${randomBytes(8).toString("hex")}`);
      const handle = await fs.open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(temp, path.join(dir, `${next.generation}.json`));
      } catch (cause) {
        if (errorCode(cause) === "EEXIST") return "conflict";
        throw cause;
      } finally {
        await fs.rm(temp, { force: true });
      }
      const directory = await fs.open(dir, constants.O_RDONLY);
      await directory.sync().finally(() => directory.close());
      // Keep the previous generation so a concurrent reader's listing still resolves.
      for (const generation of await generations(dir))
        if (generation < next.generation - 1)
          await fs.rm(path.join(dir, `${generation}.json`), { force: true });
      return "committed";
    },
  };
}
