import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

import { findWorkspaceAgentTarget } from "../../../../scripts/lib/workspace-agent-target.ts";
import { resolveLocalWorkspaceWatchAgentBinary } from "../remote-agent/localWorkspaceWatchAgent.binary.ts";
import { REMOTE_AGENT_PROTOCOL_MAJOR } from "../remote-agent/remoteAgentProtocol.ts";
import {
  assertPrivateDirectory,
  ensurePrivateDirectory,
  pathExists,
  sha256File,
  writeFileAtomic,
} from "./localTerminalHost.fs.ts";
import {
  localTerminalHostRuntimeSegment,
  localTerminalHostStagedBinaryPath,
  type LocalTerminalHostPaths,
} from "./localTerminalHost.paths.ts";

export class LocalTerminalHostBinaryError extends Error {
  readonly _tag = "LocalTerminalHostBinaryError";
}

/** Parsed `bigbud-remote-agent --check` identity line. */
export interface LocalAgentCheck {
  readonly version: string;
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly buildDigest: string;
  readonly os: string;
  readonly architecture: string;
}

export function parseLocalAgentCheck(stdout: string): LocalAgentCheck | undefined {
  const fields = stdout.trim().split("\t");
  if (fields[0] !== "bigbud-remote-agent" || fields.length < 7) return undefined;
  const protocolMajor = Number(fields[2]);
  const protocolMinor = Number(fields[3]);
  if (!Number.isSafeInteger(protocolMajor) || !Number.isSafeInteger(protocolMinor))
    return undefined;
  if (!fields[1] || !fields[4] || !fields[5] || !fields[6]) return undefined;
  return {
    version: fields[1],
    protocolMajor,
    protocolMinor,
    buildDigest: fields[4],
    os: fields[5],
    architecture: fields[6],
  };
}

export type LocalAgentCheckProbe = (path: string) => LocalAgentCheck | undefined;

export const probeLocalAgentCheck: LocalAgentCheckProbe = (path) => {
  const result = spawnSync(path, ["--check"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return parseLocalAgentCheck(result.stdout);
};

/** Host compatibility at staging time is the protocol major and platform only (never minor). */
export function assertLocalTerminalHostCheck(
  check: LocalAgentCheck | undefined,
  path: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): LocalAgentCheck {
  const target = findWorkspaceAgentTarget(platform, architecture);
  if (
    !check ||
    !target ||
    check.protocolMajor !== REMOTE_AGENT_PROTOCOL_MAJOR ||
    check.os !== target.rustOs ||
    check.architecture !== target.rustArch
  )
    throw new LocalTerminalHostBinaryError(
      `The terminal host binary is incompatible with protocol ${REMOTE_AGENT_PROTOCOL_MAJOR} on ${platform}/${architecture}: ${path}`,
    );
  return check;
}

export interface LocalTerminalHostSource {
  readonly path: string;
  readonly check: LocalAgentCheck;
}

/** Same lookup as the local workspace agent (env override, repository build, packaged copy). */
export function resolveLocalTerminalHostSource(
  probe: LocalAgentCheckProbe = probeLocalAgentCheck,
  resolvePath: typeof resolveLocalWorkspaceWatchAgentBinary = resolveLocalWorkspaceWatchAgentBinary,
): LocalTerminalHostSource {
  let check: LocalAgentCheck | undefined;
  const path = resolvePath({
    verifyBinary: (candidate, platform, architecture) => {
      check = assertLocalTerminalHostCheck(probe(candidate), candidate, platform, architecture);
    },
  });
  if (!check) throw new LocalTerminalHostBinaryError(`Unverified terminal host binary: ${path}`);
  return { path, check };
}

export interface StagedLocalTerminalHostBinary {
  readonly path: string;
  readonly sha256: string;
  readonly check: LocalAgentCheck;
}

/**
 * Copies the packaged binary to `runtimes/<buildDigest>/` so a running host survives AppImage
 * unmounts, app moves and updates. The copy is fsynced, `0700`, and verified by bytes and by its
 * own `--check` digest before use.
 */
export async function stageLocalTerminalHostBinary(
  paths: LocalTerminalHostPaths,
  source: LocalTerminalHostSource,
  probe: LocalAgentCheckProbe = probeLocalAgentCheck,
): Promise<StagedLocalTerminalHostBinary> {
  const destination = localTerminalHostStagedBinaryPath(paths, source.check.buildDigest);
  await ensurePrivateDirectory(paths.root);
  await ensurePrivateDirectory(paths.runtimesDir);
  await ensurePrivateDirectory(dirname(destination));
  const sourceHash = await sha256File(source.path);
  if (await pathExists(destination)) {
    const existing = await verifiedHash(destination).catch(() => undefined);
    if (existing === sourceHash)
      return { path: destination, sha256: sourceHash, check: source.check };
  }
  await writeFileAtomic(destination, await fs.readFile(source.path), 0o700);
  const stagedHash = await sha256File(destination);
  const stagedCheck = probe(destination);
  if (stagedHash !== sourceHash || stagedCheck?.buildDigest !== source.check.buildDigest) {
    await fs.rm(destination, { force: true });
    throw new LocalTerminalHostBinaryError("The staged terminal host binary failed verification.");
  }
  return { path: destination, sha256: sourceHash, check: source.check };
}

async function verifiedHash(path: string): Promise<string> {
  const stat = await fs.lstat(path);
  const uid = process.getuid?.();
  if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o7777) !== 0o700)
    throw new LocalTerminalHostBinaryError(`Unsafe staged terminal host binary: ${path}`);
  return sha256File(path);
}

/** Run before every launch: ownership, `0700`, private parents and unchanged bytes. */
export async function verifyStagedLocalTerminalHostBinary(
  paths: LocalTerminalHostPaths,
  staged: StagedLocalTerminalHostBinary,
): Promise<void> {
  for (const directory of [paths.root, paths.runtimesDir, dirname(staged.path)])
    await assertPrivateDirectory(directory);
  if ((await verifiedHash(staged.path)) !== staged.sha256)
    throw new LocalTerminalHostBinaryError("The staged terminal host binary changed on disk.");
}

/**
 * Removes runtimes no live generation references. `keepDigests` must include the current staged
 * build and every build named by a host record; unknown directory names are left alone.
 */
export async function collectLocalTerminalHostRuntimes(
  paths: LocalTerminalHostPaths,
  keepDigests: Iterable<string>,
): Promise<ReadonlyArray<string>> {
  const keep = new Set(Array.from(keepDigests, localTerminalHostRuntimeSegment));
  let entries: ReadonlyArray<string>;
  try {
    entries = await fs.readdir(paths.runtimesDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const removed: Array<string> = [];
  for (const entry of entries) {
    if (keep.has(entry) || entry.startsWith(".")) continue;
    if (localTerminalHostRuntimeSegment(entry) !== entry) continue;
    const directory = join(paths.runtimesDir, entry);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    await fs.rm(directory, { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}
