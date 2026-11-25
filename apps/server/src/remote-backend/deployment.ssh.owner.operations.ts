import { deploymentError, DEPLOYMENT_REQUEST_ID } from "./deployment.types.ts";

/**
 * Typed deployment steps for the owner-selected runner. The owner compiles every
 * program, argument, cwd and environment value; callers name a step and supply
 * only bounded, validated operands.
 *
 * Cancellation names this operation lease only. `reattach` reads the retained
 * outcome for a request id and never dispatches work, so a step whose result was
 * not confirmed stays `outcomeUnknown` and is never replayed.
 */
export const DEPLOYMENT_STEP_ACTIONS = [
  "archiveUpload",
  "reset",
  "fetch",
  "publish",
  "start",
  "cancel",
  "reattach",
] as const;
export type DeploymentStepAction = (typeof DEPLOYMENT_STEP_ACTIONS)[number];

export const DEPLOYMENT_OPERATION_STATES = [
  "started",
  "completed",
  "cancelled",
  "outcomeUnknown",
  "refused",
] as const;
export type DeploymentOperationState = (typeof DEPLOYMENT_OPERATION_STATES)[number];

/** Mirrors the owner's single-frame bound so callers fail before the wire. */
export const MAX_DEPLOYMENT_ARCHIVE_BYTES = 48 * 1024;
export const MAX_DEPLOYMENT_PINS = 16;
const MAX_FETCH_BYTES = 2 * 1024 ** 3;
const MAX_URL_LENGTH = 2048;
const MAX_INSTALL_NAME = 128;
const GRAPH_RELATIVE_PATH = /^[A-Za-z0-9._+-]{1,255}(?:\/[A-Za-z0-9._+-]{1,255}){0,16}$/;
const PINNED_URL = /^https:\/\/[A-Za-z0-9._~:/?#@!*+,;=%()[\]-]{1,2048}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const AUTHORITY = /^[a-f0-9]{32}$/;
const INSTALL_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}-(?:aarch64|x86_64)-unknown-linux-(?:gnu|musl)-[a-f0-9]{16}$/;

export interface DeploymentPinnedFile {
  readonly path: string;
  readonly sha256: string;
}

export interface DeploymentStepRequest {
  readonly executionTargetId: string;
  readonly action: DeploymentStepAction;
  /** Stable deployment request id; it is also the operation identity for cancel/reattach. */
  readonly requestId: string;
  readonly installName?: string;
  readonly archiveSha256?: string;
  readonly manifestSha256?: string;
  readonly url?: string;
  readonly maxBytes?: number;
  readonly contents?: Uint8Array;
  readonly authorityId?: string;
  readonly enableBoot?: boolean;
  readonly nodePath?: string;
  readonly entryPath?: string;
  readonly pins?: ReadonlyArray<DeploymentPinnedFile>;
}

export interface DeploymentStepOutcome {
  readonly requestId: string;
  readonly action: DeploymentStepAction;
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly state: DeploymentOperationState;
  /** A dispatched step without a confirmed result: reattach, never replay. */
  readonly outcomeUnknown: boolean;
  /** This outcome was read back for an earlier operation; no work ran. */
  readonly reattached: boolean;
}

export type DeploymentStepRunner = (
  request: DeploymentStepRequest,
  signal: AbortSignal,
) => Promise<DeploymentStepOutcome>;

const invalid = (message: string) => deploymentError("invalid-target", message);

function graphPath(value: string | undefined, label: string): string {
  if (!value || !GRAPH_RELATIVE_PATH.test(value) || value.split("/").includes(".."))
    throw invalid(`Invalid deployment ${label} path.`);
  return value;
}

/** Fail closed on any operand the owner would refuse, before dispatch. */
export function validateDeploymentStep(request: DeploymentStepRequest): void {
  if (
    (DEPLOYMENT_STEP_ACTIONS as ReadonlyArray<string>).includes(request.action) === false ||
    !DEPLOYMENT_REQUEST_ID.test(request.requestId) ||
    !request.executionTargetId.startsWith("ssh:")
  ) {
    throw invalid("Invalid deployment step.");
  }
  const digest = (value: string | undefined, label: string) => {
    if (!value || !SHA256.test(value)) throw invalid(`Invalid deployment ${label} digest.`);
    return value;
  };
  const install = () => {
    const name = request.installName;
    if (!name || name.length > MAX_INSTALL_NAME || !INSTALL_NAME.test(name))
      throw invalid("Invalid deployment install name.");
    return name;
  };
  switch (request.action) {
    case "archiveUpload": {
      const contents = request.contents;
      digest(request.archiveSha256, "archive");
      if (
        !contents ||
        contents.byteLength < 1 ||
        contents.byteLength > MAX_DEPLOYMENT_ARCHIVE_BYTES
      )
        throw invalid("Deployment archive bytes are outside the bounded upload.");
      return;
    }
    case "reset":
      install();
      digest(request.archiveSha256, "archive");
      digest(request.manifestSha256, "manifest");
      return;
    case "fetch": {
      digest(request.archiveSha256, "archive");
      const { url, maxBytes } = request;
      if (
        !url ||
        url.length > MAX_URL_LENGTH ||
        !PINNED_URL.test(url) ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes === undefined ||
        maxBytes < 1 ||
        maxBytes > MAX_FETCH_BYTES
      )
        throw invalid("Invalid deployment fetch operand.");
      return;
    }
    case "publish": {
      install();
      digest(request.archiveSha256, "archive");
      digest(request.manifestSha256, "manifest");
      const pins = request.pins;
      if (!pins || pins.length < 1 || pins.length > MAX_DEPLOYMENT_PINS)
        throw invalid("Invalid deployment publication pins.");
      for (const pin of pins) {
        graphPath(pin.path, "pin");
        if (!SHA256.test(pin.sha256)) throw invalid("Invalid deployment pin digest.");
      }
      graphPath(request.nodePath, "node");
      graphPath(request.entryPath, "entry");
      return;
    }
    case "start":
      install();
      if (!request.authorityId || !AUTHORITY.test(request.authorityId))
        throw invalid("Invalid deployment authority.");
      if (typeof request.enableBoot !== "boolean") throw invalid("Invalid boot consent.");
      graphPath(request.nodePath, "node");
      graphPath(request.entryPath, "entry");
      return;
    case "cancel":
    case "reattach":
      return;
  }
}

/**
 * Classify one owner result. A step whose dispatch was attempted without a
 * confirmed result is reported unknown rather than retried, and cancellation is
 * terminal for that request id.
 */
export function classifyDeploymentOutcome(
  request: DeploymentStepRequest,
  result: {
    readonly code: number | undefined;
    readonly stdout: string;
    readonly stderr: string;
    readonly state?: DeploymentOperationState | undefined;
  },
  reattached = false,
): DeploymentStepOutcome {
  const state = result.state ?? "completed";
  const outcomeUnknown = state === "outcomeUnknown" || result.code === undefined;
  return {
    requestId: request.requestId,
    action: request.action,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    state: outcomeUnknown ? "outcomeUnknown" : state,
    outcomeUnknown,
    reattached,
  };
}

/** The typed `cancel`/`reattach` steps share this shape and never carry extra operands. */
export function deploymentControlRequest(
  executionTargetId: string,
  requestId: string,
  action: "cancel" | "reattach",
): DeploymentStepRequest {
  return Object.freeze({ executionTargetId, requestId, action });
}
