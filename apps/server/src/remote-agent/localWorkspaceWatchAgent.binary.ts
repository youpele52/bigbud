import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { findWorkspaceAgentTarget } from "../../../../scripts/lib/workspace-agent-target.ts";

import { REMOTE_AGENT_PROTOCOL_MAJOR, REMOTE_AGENT_PROTOCOL_MINOR } from "./remoteAgentProtocol.ts";

const BINARY_ENV = "BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY";
const CHECK_TIMEOUT_MS = 5_000;
const CHECK_MAX_BUFFER_BYTES = 64 * 1024;

export class LocalWorkspaceWatchAgentUnavailableError extends Error {
  readonly _tag = "LocalWorkspaceWatchAgentUnavailableError";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "LocalWorkspaceWatchAgentUnavailableError";
  }
}

export interface LocalWorkspaceWatchAgentBinaryInput {
  readonly environment?: NodeJS.ProcessEnv;
  readonly architecture?: string;
  readonly packagedBinaryPath?: string;
  readonly packageRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly searchFrom?: ReadonlyArray<string>;
  readonly verifyBinary?: (path: string, platform: NodeJS.Platform, architecture: string) => void;
}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "bigbud-remote-agent.exe" : "bigbud-remote-agent";
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function rustIdentity(platform: NodeJS.Platform, architecture: string) {
  const target = findWorkspaceAgentTarget(platform, architecture);
  if (!target) {
    throw new LocalWorkspaceWatchAgentUnavailableError(
      `The local workspace watcher does not support ${platform}/${architecture}.`,
    );
  }
  return { os: target.rustOs, arch: target.rustArch };
}

interface BinaryProbeResult {
  readonly status: number | null;
  readonly stdout: string | undefined;
  readonly stderr: string;
  readonly error?: Error;
}

type BinaryProbe = (
  path: string,
  args: ReadonlyArray<string>,
  options: { readonly encoding: "utf8"; readonly timeout: number; readonly maxBuffer: number },
) => BinaryProbeResult;

export function verifyLocalWorkspaceWatchAgentBinary(
  path: string,
  platform: NodeJS.Platform,
  architecture: string,
  probe: BinaryProbe = spawnSync,
): void {
  const expected = rustIdentity(platform, architecture);
  const result = probe(path, ["--check"], {
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: CHECK_MAX_BUFFER_BYTES,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const fields = stdout.trim().split("\t");
  if (
    result.error ||
    result.status !== 0 ||
    fields[0] !== "bigbud-remote-agent" ||
    Number(fields[2]) !== REMOTE_AGENT_PROTOCOL_MAJOR ||
    Number(fields[3]) !== REMOTE_AGENT_PROTOCOL_MINOR ||
    fields[5] !== expected.os ||
    fields[6] !== expected.arch
  ) {
    throw new LocalWorkspaceWatchAgentUnavailableError(
      `Local workspace watcher agent is incompatible with protocol ` +
        `${REMOTE_AGENT_PROTOCOL_MAJOR}.${REMOTE_AGENT_PROTOCOL_MINOR} and ` +
        `${platform}/${architecture}: ${path}`,
    );
  }
}

function packagedServerBinary(
  start: string,
  name: string,
  platform: NodeJS.Platform,
  architecture: string,
): string | null {
  const candidate = join(start, "workspace-agent", `${platform}-${architecture}`, name);
  return isExecutableFile(candidate, platform) ? candidate : null;
}

function repositoryBinary(start: string, name: string, platform: NodeJS.Platform): string | null {
  let directory = resolve(start);
  for (;;) {
    const cargoManifest = join(directory, "Cargo.toml");
    const candidate = join(directory, "target", "debug", name);
    if (existsSync(cargoManifest) && isExecutableFile(candidate, platform)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function resolveLocalWorkspaceWatchAgentBinary(
  input: LocalWorkspaceWatchAgentBinaryInput = {},
): string {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const architecture = input.architecture ?? process.arch;
  rustIdentity(platform, architecture);
  const verify = input.verifyBinary ?? verifyLocalWorkspaceWatchAgentBinary;
  const accept = (path: string) => {
    verify(path, platform, architecture);
    return path;
  };
  const configured = environment[BINARY_ENV]?.trim();
  if (configured) {
    const path = resolve(configured);
    if (isExecutableFile(path, platform)) return accept(path);
    throw new LocalWorkspaceWatchAgentUnavailableError(
      `${BINARY_ENV} does not point to an executable file: ${path}`,
    );
  }

  if (input.packagedBinaryPath) {
    const path = resolve(input.packagedBinaryPath);
    if (isExecutableFile(path, platform)) return accept(path);
  }

  const name = binaryName(platform);
  let repository: string | null = null;
  for (const start of input.searchFrom ?? [process.cwd(), import.meta.dirname]) {
    repository = repositoryBinary(start, name, platform);
    if (repository) break;
  }
  if (environment.BIGBUD_DESKTOP_PACKAGED !== "1" && repository) {
    return accept(repository);
  }
  const packaged = packagedServerBinary(
    input.packageRoot ?? import.meta.dirname,
    name,
    platform,
    architecture,
  );
  if (packaged) return accept(packaged);
  if (repository) return accept(repository);

  throw new LocalWorkspaceWatchAgentUnavailableError(
    `Local workspace watcher agent is unavailable. Set ${BINARY_ENV} or run ` +
      "cargo build --locked --package bigbud-remote-agent from the repository root.",
  );
}
