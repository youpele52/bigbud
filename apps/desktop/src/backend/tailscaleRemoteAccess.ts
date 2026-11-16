import * as ChildProcess from "node:child_process";
import { promisify } from "node:util";

import {
  assessServeMapping,
  describeForeignServeMapping,
  describeOtherServeRoutes,
  describeServeMappingError,
  isOnlyOwnHttpsHandler,
} from "./tailscaleRemoteAccess.serveConfig";
import { NO_SERVE_OWNERSHIP, type ServeOwnershipStore } from "./tailscaleRemoteAccess.ownership";

const execFile = promisify(ChildProcess.execFile);

/**
 * Bounds every Tailscale CLI call. Desktop startup awaits status checks, so a
 * wedged daemon must fail the check rather than hang bootstrap.
 */
const TAILSCALE_COMMAND_TIMEOUT_MS = 10_000;
const TAILSCALE_EXEC_OPTIONS = {
  encoding: "utf8",
  windowsHide: true,
  timeout: TAILSCALE_COMMAND_TIMEOUT_MS,
  killSignal: "SIGKILL",
} as const satisfies ChildProcess.ExecFileOptions;

const TAILSCALE_BINARY = "tailscale";
const LOOPBACK_PROXY_TARGET_HOST = "127.0.0.1";

interface TailscaleStatusResponse {
  readonly BackendState?: unknown;
  readonly Self?: {
    readonly DNSName?: unknown;
    readonly Online?: unknown;
  };
}

export interface DesktopTailscaleRemoteAccessStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly online: boolean;
  readonly serving: boolean;
  readonly remoteBaseUrl: string | null;
  readonly error: string | null;
}

interface ExecFileLikeResult {
  readonly stdout: string;
  readonly stderr: string;
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options?: ChildProcess.ExecFileOptions,
) => Promise<ExecFileLikeResult>;

function normalizeDnsName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Tailscale command failed.";
}

async function runTailscaleJsonCommand(
  args: readonly string[],
  runExecFile: ExecFileLike = execFile,
): Promise<unknown> {
  const result = await runExecFile(TAILSCALE_BINARY, args, TAILSCALE_EXEC_OPTIONS);
  return JSON.parse(result.stdout);
}

function buildRemoteBaseUrl(hostname: string | null): string | null {
  return hostname ? `https://${hostname}` : null;
}

function isOnline(value: unknown): boolean {
  return value === true;
}

export async function getDesktopTailscaleRemoteAccessStatus(
  backendPort: number,
  runExecFile: ExecFileLike = execFile,
  ownership: ServeOwnershipStore = NO_SERVE_OWNERSHIP,
): Promise<DesktopTailscaleRemoteAccessStatus> {
  try {
    const status = (await runTailscaleJsonCommand(
      ["status", "--json"],
      runExecFile,
    )) as TailscaleStatusResponse;
    const running = status.BackendState === "Running";
    const online = isOnline(status.Self?.Online);
    const remoteBaseUrl = buildRemoteBaseUrl(normalizeDnsName(status.Self?.DNSName));

    if (!running) {
      return {
        installed: true,
        running: false,
        online: false,
        serving: false,
        remoteBaseUrl,
        error: "Tailscale is installed but the daemon is not running.",
      };
    }

    if (!online) {
      return {
        installed: true,
        running: true,
        online: false,
        serving: false,
        remoteBaseUrl,
        error: "Tailscale is running but this device is offline.",
      };
    }

    const serveConfig = await readServeConfig(runExecFile);
    const error = describeServeMappingError(
      assessServeMapping(serveConfig, backendPort, ownership.read()),
      backendPort,
    );

    return {
      installed: true,
      running: true,
      online: true,
      serving: error === null,
      remoteBaseUrl,
      error,
    };
  } catch (error) {
    const errorMessage = normalizeError(error);
    const installed = !errorMessage.includes("ENOENT");
    return {
      installed,
      running: false,
      online: false,
      serving: false,
      remoteBaseUrl: null,
      error: installed ? errorMessage : "Tailscale CLI is not installed.",
    };
  }
}

function readServeConfig(runExecFile: ExecFileLike): Promise<unknown> {
  return runTailscaleJsonCommand(["serve", "status", "--json"], runExecFile);
}

/** Read the live target; a stale ownership file alone never grants boot migration. */
export async function hasDesktopServeTarget(
  port: number,
  runExecFile: ExecFileLike = execFile,
): Promise<boolean> {
  return assessServeMapping(await readServeConfig(runExecFile), port).kind === "current";
}

/**
 * Points HTTPS 443 `/` at this backend. Replaces only an absent root handler or
 * the mapping bigbud recorded configuring earlier; never another service.
 */
export async function enableDesktopTailscaleRemoteAccess(
  backendPort: number,
  runExecFile: ExecFileLike = execFile,
  ownership: ServeOwnershipStore = NO_SERVE_OWNERSHIP,
  migration?: { readonly existingPort: number; readonly onMutation: () => void },
  assertCanMutate: () => void = () => undefined,
): Promise<DesktopTailscaleRemoteAccessStatus> {
  const config = await readServeConfig(runExecFile);
  assertCanMutate();
  if (migration && assessServeMapping(config, migration.existingPort).kind !== "current") {
    throw new Error("Recorded Serve target is no longer present; migration cancelled.");
  }
  const assessment = assessServeMapping(config, backendPort, ownership.read());
  if (assessment.kind === "foreign") {
    throw new Error(describeForeignServeMapping(assessment.loopbackPort));
  }
  if (assessment.kind !== "current") {
    migration?.onMutation();
    await runExecFile(
      TAILSCALE_BINARY,
      ["serve", "--yes", "--bg", `http://${LOOPBACK_PROXY_TARGET_HOST}:${backendPort}`],
      TAILSCALE_EXEC_OPTIONS,
    );
  }
  ownership.write(backendPort);
  return getDesktopTailscaleRemoteAccessStatus(backendPort, runExecFile, ownership);
}

/**
 * Removes bigbud's Serve handler (current, or the stale one it recorded) only
 * when it is the sole Serve handler, so other routes are never wiped.
 */
export async function disableDesktopTailscaleRemoteAccess(
  backendPort: number,
  runExecFile: ExecFileLike = execFile,
  ownership: ServeOwnershipStore = NO_SERVE_OWNERSHIP,
  assertCanMutate: () => void = () => undefined,
): Promise<DesktopTailscaleRemoteAccessStatus> {
  const serveConfig = await readServeConfig(runExecFile);
  assertCanMutate();
  const assessment = assessServeMapping(serveConfig, backendPort, ownership.read());
  const ownPort =
    assessment.kind === "current"
      ? backendPort
      : assessment.kind === "stale"
        ? assessment.stalePort
        : null;
  if (ownPort === null) {
    return getDesktopTailscaleRemoteAccessStatus(backendPort, runExecFile, ownership);
  }
  if (!isOnlyOwnHttpsHandler(serveConfig, ownPort)) {
    throw new Error(
      `Tailscale Serve has other routes on this device (${describeOtherServeRoutes(serveConfig, ownPort)}). Turning off HTTPS would remove them too, so bigbud changed nothing. To stop only bigbud's route, remove "/" → 127.0.0.1:${ownPort} yourself.`,
    );
  }
  await runExecFile(
    TAILSCALE_BINARY,
    ["serve", "--yes", "--https=443", "off"],
    TAILSCALE_EXEC_OPTIONS,
  );
  ownership.clear();
  return getDesktopTailscaleRemoteAccessStatus(backendPort, runExecFile, ownership);
}
