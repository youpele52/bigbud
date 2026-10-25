/**
 * Lists host aliases from the OpenSSH client config on the machine that runs
 * `ssh`. Read-only and bounded: it never spawns a process, so `Match exec`
 * and similar active directives are never evaluated.
 *
 * @module sshConfigDiscovery
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ServerListSshConfigHostsResult,
  ServerSshConfigHost,
  ServerSshConfigSource,
} from "@bigbud/contracts/server/server.sshConfig";

import { parseSshConfig } from "./sshConfigParse.ts";
import {
  defaultSshConfigRoots,
  displaySshConfigPath,
  expandSshConfigHome,
  type SshConfigRoot,
} from "./sshConfigSources.ts";

/** OpenSSH's own include nesting limit. */
export const SSH_CONFIG_MAX_INCLUDE_DEPTH = 16;
export const SSH_CONFIG_MAX_FILES = 64;
export const SSH_CONFIG_MAX_FILE_BYTES = 256 * 1024;
export const SSH_CONFIG_MAX_HOSTS = 1000;

export interface DiscoverSshConfigHostsOptions {
  readonly roots?: ReadonlyArray<SshConfigRoot>;
  readonly homeDir?: string;
  readonly machineName?: string;
}

interface DiscoveryState {
  readonly homeDir: string;
  readonly visited: Set<string>;
  readonly hosts: Map<string, ServerSshConfigHost>;
  readonly sources: ServerSshConfigSource[];
}

type SourceKind = ServerSshConfigSource["kind"];

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : "Unknown error.";
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function hasGlob(segment: string): boolean {
  return /[*?]/u.test(segment);
}

function globSegmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "u");
}

/** Expands `*`/`?` in any path segment, sorted like glob(3); hidden entries need an explicit dot. */
async function expandIncludePattern(pattern: string): Promise<ReadonlyArray<string>> {
  if (!hasGlob(pattern)) return [pattern];
  const { root } = path.parse(pattern);
  const segments = pattern
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0);
  let candidates = [root];
  for (const segment of segments) {
    const next: string[] = [];
    for (const directory of candidates) {
      if (!hasGlob(segment)) {
        next.push(path.join(directory, segment));
        continue;
      }
      const entries = await fs.readdir(directory).catch(() => [] as string[]);
      const matcher = globSegmentToRegExp(segment);
      for (const name of entries.toSorted()) {
        if (name.startsWith(".") && !segment.startsWith(".")) continue;
        if (matcher.test(name)) next.push(path.join(directory, name));
      }
    }
    candidates = next.slice(0, SSH_CONFIG_MAX_FILES);
  }
  return candidates;
}

function recordSource(
  state: DiscoveryState,
  filePath: string,
  kind: SourceKind,
  status: ServerSshConfigSource["status"],
  message?: string,
): void {
  state.sources.push({
    path: displaySshConfigPath(filePath, state.homeDir),
    kind,
    status,
    ...(message ? { message } : {}),
  });
}

async function readConfigFile(
  state: DiscoveryState,
  root: SshConfigRoot,
  filePath: string,
  kind: SourceKind,
  depth: number,
  fromGlob: boolean,
): Promise<void> {
  if (state.visited.size >= SSH_CONFIG_MAX_FILES) {
    recordSource(state, filePath, kind, "skipped", "SSH config file limit reached.");
    return;
  }

  let content: string;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      if (!fromGlob) recordSource(state, filePath, kind, "error", "Not a regular file.");
      return;
    }
    const realPath = await fs.realpath(filePath);
    if (state.visited.has(realPath)) {
      recordSource(state, filePath, kind, "skipped", "Already read.");
      return;
    }
    state.visited.add(realPath);
    if (stat.size > SSH_CONFIG_MAX_FILE_BYTES) {
      recordSource(state, filePath, kind, "error", "File is too large to read.");
      return;
    }
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      recordSource(state, filePath, kind, "missing");
    } else {
      recordSource(state, filePath, kind, "error", errorMessage(error));
    }
    return;
  }

  recordSource(state, filePath, kind, "loaded");
  const sourcePath = displaySshConfigPath(filePath, state.homeDir);
  for (const item of parseSshConfig(content)) {
    if (item.kind === "host") {
      if (state.hosts.has(item.alias) || state.hosts.size >= SSH_CONFIG_MAX_HOSTS) continue;
      state.hosts.set(item.alias, {
        alias: item.alias,
        sourcePath,
        line: item.line,
        ...(item.hostName ? { hostName: item.hostName } : {}),
        ...(item.user ? { user: item.user } : {}),
        ...(item.port ? { port: item.port } : {}),
      });
      continue;
    }
    for (const pattern of item.patterns) {
      await readInclude(state, root, pattern, depth + 1, `${sourcePath}:${item.line}`);
    }
  }
}

async function readInclude(
  state: DiscoveryState,
  root: SshConfigRoot,
  pattern: string,
  depth: number,
  origin: string,
): Promise<void> {
  if (depth > SSH_CONFIG_MAX_INCLUDE_DEPTH) {
    recordSource(state, pattern, "include", "skipped", `Include nesting too deep (${origin}).`);
    return;
  }
  if (pattern.includes("%") || pattern.includes("${")) {
    recordSource(
      state,
      pattern,
      "include",
      "skipped",
      `Includes with % tokens or environment variables are not listed (${origin}).`,
    );
    return;
  }
  const expanded = expandSshConfigHome(pattern, state.homeDir);
  const absolute = path.isAbsolute(expanded) ? expanded : path.join(root.includeBaseDir, expanded);
  const fromGlob = hasGlob(absolute);
  for (const filePath of await expandIncludePattern(absolute)) {
    await readConfigFile(state, root, filePath, "include", depth, fromGlob);
  }
}

export async function discoverSshConfigHosts(
  options: DiscoverSshConfigHostsOptions = {},
): Promise<ServerListSshConfigHostsResult> {
  const homeDir = options.homeDir ?? os.homedir();
  const state: DiscoveryState = {
    homeDir,
    visited: new Set(),
    hosts: new Map(),
    sources: [],
  };
  for (const root of options.roots ?? defaultSshConfigRoots(process.platform, homeDir)) {
    await readConfigFile(state, root, root.path, root.kind, 0, false);
  }
  return {
    machineName: options.machineName ?? (os.hostname().trim() || "this computer"),
    hosts: [...state.hosts.values()],
    sources: state.sources,
  };
}
