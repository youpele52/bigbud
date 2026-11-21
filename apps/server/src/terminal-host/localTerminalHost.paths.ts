import { createHash } from "node:crypto";
import { join } from "node:path";

/** One pool target for every local host generation; each generation is its own binding (F2). */
export const LOCAL_TERMINAL_HOST_TARGET_ID = "local-terminal-host";

/** Unix socket paths are capped near 104 bytes on macOS; keep a margin (plan §7.3 item 2). */
export const LOCAL_TERMINAL_HOST_MAX_SOCKET_PATH_BYTES = 100;

/** Flipped only after the Q1 qualification gate passes. */
export const LOCAL_TERMINAL_HOST_QUALIFIED = false;

/**
 * Capabilities a host must advertise before it receives new terminals. S1 uses existing frames
 * only; S2/S3 append `terminal.screen`, `terminal.lifecycle`, `terminal.local-launch` and
 * `terminal.query-responder` once protocol 1.9 (R4/R5) lands.
 */
export const LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES: ReadonlyArray<string> = [
  "terminal.pty",
  "terminal.pty-inventory",
  "workspace.files",
];

/**
 * `enabled`: new local terminals go to the Rust host.
 * `adopt-only`: the kill switch. Existing hosts are adopted and their live PTYs reattach, but no
 * host is launched and no new host PTY is created; new terminals run in-process.
 */
export type LocalTerminalHostMode = "enabled" | "adopt-only";

/** Before Q1 the host is opt-in (`=== "1"`); after Q1 it is opt-out (`=== "0"`). */
export function resolveLocalTerminalHostMode(
  environment: NodeJS.ProcessEnv = process.env,
  qualified: boolean = LOCAL_TERMINAL_HOST_QUALIFIED,
): LocalTerminalHostMode {
  const value = environment.BIGBUD_TERMINAL_HOST;
  if (qualified) return value === "0" ? "adopt-only" : "enabled";
  return value === "1" ? "enabled" : "adopt-only";
}

export interface LocalTerminalHostPaths {
  readonly root: string;
  readonly hostsFile: string;
  readonly runtimesDir: string;
}

export function localTerminalHostPaths(stateDir: string): LocalTerminalHostPaths {
  const root = join(stateDir, "terminal-host");
  return { root, hostsFile: join(root, "hosts.json"), runtimesDir: join(root, "runtimes") };
}

export interface LocalTerminalHostGenerationPaths {
  readonly generation: number;
  /** Also the pool connection id for this generation (F2). */
  readonly name: string;
  readonly statePath: string;
  readonly socketPath: string;
  readonly logPath: string;
}

const GENERATION_PATTERN = /^state-([1-9][0-9]{0,8})$/;

export function localTerminalHostGenerationName(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 999_999_999)
    throw new Error("Invalid local terminal host generation.");
  return `state-${generation}`;
}

export function parseLocalTerminalHostGeneration(name: string): number | undefined {
  const match = GENERATION_PATTERN.exec(name);
  return match ? Number(match[1]) : undefined;
}

export function localTerminalHostGenerationPaths(
  root: string,
  generation: number,
): LocalTerminalHostGenerationPaths {
  const name = localTerminalHostGenerationName(generation);
  const statePath = join(root, name);
  return {
    generation,
    name,
    statePath,
    socketPath: join(statePath, "supervisor.sock"),
    logPath: join(statePath, "host.log"),
  };
}

export function localTerminalHostSocketPathTooLong(socketPath: string): boolean {
  return Buffer.byteLength(socketPath) > LOCAL_TERMINAL_HOST_MAX_SOCKET_PATH_BYTES;
}

/** A build digest becomes one path segment; anything unusual is hashed instead of trusted. */
export function localTerminalHostRuntimeSegment(buildDigest: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(buildDigest) && !buildDigest.includes(".."))
    return buildDigest;
  return `h-${createHash("sha256").update(buildDigest).digest("hex")}`;
}

export function localTerminalHostStagedBinaryPath(
  paths: LocalTerminalHostPaths,
  buildDigest: string,
): string {
  return join(
    paths.runtimesDir,
    localTerminalHostRuntimeSegment(buildDigest),
    "bigbud-remote-agent",
  );
}
