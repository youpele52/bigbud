import * as ChildProcess from "node:child_process";
import { promisify } from "node:util";

import type {
  DesktopTailscaleRemoteAccessStatus,
  DesktopTailscaleServeConflict,
} from "@bigbud/contracts";

import {
  assessServeMapping,
  describeBigbudServeMapping,
  describeOtherServeRoutes,
  describeServeMappingError,
  isOnlyOwnHandlerOnListener,
  type ServeMappingAssessment,
  type ServeTarget,
} from "./tailscaleRemoteAccess.serveConfig";
import { NO_SERVE_OWNERSHIP, type ServeOwnershipStore } from "./tailscaleRemoteAccess.ownership";
import {
  NO_LOOPBACK_OWNER_DETECTOR,
  type LoopbackOwnerDetector,
} from "./tailscaleRemoteAccess.takeover";

export type { DesktopTailscaleRemoteAccessStatus };

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

/** The origin pairing links carry: Serve's default 443 is implicit, other ports explicit. */
export function buildRemoteBaseUrl(hostname: string | null, httpsPort: number): string | null {
  if (!hostname) return null;
  return httpsPort === 443 ? `https://${hostname}` : `https://${hostname}:${httpsPort}`;
}

function isOnline(value: unknown): boolean {
  return value === true;
}

function targetFor(backendPort: number, ownership: ServeOwnershipStore): ServeTarget {
  return { backendPort, httpsPort: ownership.httpsPort };
}

function offlineStatus(
  fields: Pick<DesktopTailscaleRemoteAccessStatus, "installed" | "running" | "remoteBaseUrl">,
  httpsPort: number,
  error: string,
): DesktopTailscaleRemoteAccessStatus {
  return { ...fields, online: false, serving: false, httpsPort, conflict: null, error };
}

/** Describes a foreign handler, naming another bigbud when local evidence proves one. */
async function resolveConflict(
  assessment: ServeMappingAssessment,
  target: ServeTarget,
  detectOwner: LoopbackOwnerDetector,
): Promise<{ conflict: DesktopTailscaleServeConflict; error: string } | null> {
  if (assessment.kind !== "foreign") return null;
  const owner =
    assessment.loopbackPort === null ? null : await detectOwner(assessment.loopbackPort);
  const conflict = {
    loopbackPort: assessment.loopbackPort,
    bigbudOwnerLabel: owner?.label ?? null,
    canTakeOver: owner !== null,
  };
  const error =
    owner !== null && assessment.loopbackPort !== null
      ? describeBigbudServeMapping(assessment.loopbackPort, target.httpsPort, owner.label)
      : describeServeMappingError(assessment, target)!;
  return { conflict, error };
}

export async function getDesktopTailscaleRemoteAccessStatus(
  backendPort: number,
  runExecFile: ExecFileLike = execFile,
  ownership: ServeOwnershipStore = NO_SERVE_OWNERSHIP,
  detectOwner: LoopbackOwnerDetector = NO_LOOPBACK_OWNER_DETECTOR,
): Promise<DesktopTailscaleRemoteAccessStatus> {
  const target = targetFor(backendPort, ownership);
  try {
    const status = (await runTailscaleJsonCommand(
      ["status", "--json"],
      runExecFile,
    )) as TailscaleStatusResponse;
    const running = status.BackendState === "Running";
    const online = isOnline(status.Self?.Online);
    const remoteBaseUrl = buildRemoteBaseUrl(
      normalizeDnsName(status.Self?.DNSName),
      target.httpsPort,
    );

    if (!running) {
      return offlineStatus(
        { installed: true, running: false, remoteBaseUrl },
        target.httpsPort,
        "Tailscale is installed but the daemon is not running.",
      );
    }

    if (!online) {
      return offlineStatus(
        { installed: true, running: true, remoteBaseUrl },
        target.httpsPort,
        "Tailscale is running but this device is offline.",
      );
    }

    const assessment = assessServeMapping(
      await readServeConfig(runExecFile),
      target,
      ownership.read(),
    );
    const foreign = await resolveConflict(assessment, target, detectOwner);
    const error = foreign?.error ?? describeServeMappingError(assessment, target);

    return {
      installed: true,
      running: true,
      online: true,
      serving: error === null,
      remoteBaseUrl,
      httpsPort: target.httpsPort,
      conflict: foreign?.conflict ?? null,
      error,
    };
  } catch (error) {
    const errorMessage = normalizeError(error);
    const installed = !errorMessage.includes("ENOENT");
    return offlineStatus(
      { installed, running: false, remoteBaseUrl: null },
      target.httpsPort,
      installed ? errorMessage : "Tailscale CLI is not installed.",
    );
  }
}

function readServeConfig(runExecFile: ExecFileLike): Promise<unknown> {
  return runTailscaleJsonCommand(["serve", "status", "--json"], runExecFile);
}

function pointServeAt(target: ServeTarget, runExecFile: ExecFileLike): Promise<ExecFileLikeResult> {
  // `--https=<port>` with the default "/" mount replaces only that listener's root
  // handler; other listeners and other mounts are left as they are.
  return runExecFile(
    TAILSCALE_BINARY,
    [
      "serve",
      "--yes",
      "--bg",
      `--https=${target.httpsPort}`,
      `http://${LOOPBACK_PROXY_TARGET_HOST}:${target.backendPort}`,
    ],
    TAILSCALE_EXEC_OPTIONS,
  );
}

/** Read the live target; a stale ownership file alone never grants boot migration. */
export async function hasDesktopServeTarget(
  target: ServeTarget,
  runExecFile: ExecFileLike = execFile,
): Promise<boolean> {
  return assessServeMapping(await readServeConfig(runExecFile), target).kind === "current";
}

/**
 * Points this channel's HTTPS port `/` at this backend. Replaces only an absent
 * root handler or the mapping bigbud recorded configuring earlier; never another
 * service. A foreign handler is reported in the returned status (with a take
 * over offer when it is another bigbud) instead of thrown, so the UI renders it.
 */
export async function enableDesktopTailscaleRemoteAccess(
  backendPort: number,
  runExecFile: ExecFileLike = execFile,
  ownership: ServeOwnershipStore = NO_SERVE_OWNERSHIP,
  migration?: { readonly existingPort: number; readonly onMutation: () => void },
  assertCanMutate: () => void = () => undefined,
  detectOwner: LoopbackOwnerDetector = NO_LOOPBACK_OWNER_DETECTOR,
): Promise<DesktopTailscaleRemoteAccessStatus> {
  const target = targetFor(backendPort, ownership);
  const config = await readServeConfig(runExecFile);
  assertCanMutate();
  if (
    migration &&
    assessServeMapping(config, { ...target, backendPort: migration.existingPort }).kind !==
      "current"
  ) {
    throw new Error("Recorded Serve target is no longer present; migration cancelled.");
  }
  const assessment = assessServeMapping(config, target, ownership.read());
  if (assessment.kind === "foreign") {
    return getDesktopTailscaleRemoteAccessStatus(backendPort, runExecFile, ownership, detectOwner);
  }
  if (assessment.kind !== "current") {
    migration?.onMutation();
    await pointServeAt(target, runExecFile);
  }
  ownership.write(backendPort);
  return getDesktopTailscaleRemoteAccessStatus(backendPort, runExecFile, ownership, detectOwner);
}

/**
 * Explicit user action only: replaces this channel's HTTPS `/` handler when it
 * forwards to another bigbud backend (proven by `detectOwner` at the moment of
 * the action). A non-bigbud handler is never replaced; its status is returned.
 */
export async function takeOverDesktopTailscaleRemoteAccess(
  backendPort: number,
  runExecFile: ExecFileLike = execFile,
  ownership: ServeOwnershipStore = NO_SERVE_OWNERSHIP,
  assertCanMutate: () => void = () => undefined,
  detectOwner: LoopbackOwnerDetector = NO_LOOPBACK_OWNER_DETECTOR,
): Promise<DesktopTailscaleRemoteAccessStatus> {
  const target = targetFor(backendPort, ownership);
  const assessment = assessServeMapping(
    await readServeConfig(runExecFile),
    target,
    ownership.read(),
  );
  if (assessment.kind !== "foreign") {
    return enableDesktopTailscaleRemoteAccess(
      backendPort,
      runExecFile,
      ownership,
      undefined,
      assertCanMutate,
      detectOwner,
    );
  }
  const owner =
    assessment.loopbackPort === null ? null : await detectOwner(assessment.loopbackPort);
  assertCanMutate();
  if (owner !== null) {
    await pointServeAt(target, runExecFile);
    ownership.write(backendPort);
  }
  return getDesktopTailscaleRemoteAccessStatus(backendPort, runExecFile, ownership, detectOwner);
}

/**
 * Removes bigbud's Serve handler (current, or the stale one it recorded) only
 * when it is the sole handler on this channel's HTTPS port, so other routes and
 * other channels' ports are never wiped.
 */
export async function disableDesktopTailscaleRemoteAccess(
  backendPort: number,
  runExecFile: ExecFileLike = execFile,
  ownership: ServeOwnershipStore = NO_SERVE_OWNERSHIP,
  assertCanMutate: () => void = () => undefined,
  detectOwner: LoopbackOwnerDetector = NO_LOOPBACK_OWNER_DETECTOR,
): Promise<DesktopTailscaleRemoteAccessStatus> {
  const target = targetFor(backendPort, ownership);
  const serveConfig = await readServeConfig(runExecFile);
  assertCanMutate();
  const assessment = assessServeMapping(serveConfig, target, ownership.read());
  const ownPort =
    assessment.kind === "current"
      ? backendPort
      : assessment.kind === "stale"
        ? assessment.stalePort
        : null;
  if (ownPort === null) {
    return getDesktopTailscaleRemoteAccessStatus(backendPort, runExecFile, ownership, detectOwner);
  }
  if (!isOnlyOwnHandlerOnListener(serveConfig, ownPort, target.httpsPort)) {
    throw new Error(
      `Tailscale Serve has other routes on HTTPS port ${target.httpsPort} (${describeOtherServeRoutes(serveConfig, ownPort, target.httpsPort)}). Turning off that port would remove them too, so bigbud changed nothing. To stop only bigbud's route, remove "/" → 127.0.0.1:${ownPort} yourself.`,
    );
  }
  await runExecFile(
    TAILSCALE_BINARY,
    ["serve", "--yes", `--https=${target.httpsPort}`, "off"],
    TAILSCALE_EXEC_OPTIONS,
  );
  ownership.clear();
  return getDesktopTailscaleRemoteAccessStatus(backendPort, runExecFile, ownership, detectOwner);
}
