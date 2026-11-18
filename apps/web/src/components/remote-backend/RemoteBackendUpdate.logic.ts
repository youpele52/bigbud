import type { RemoteBackendClientHandshake } from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import {
  RemoteRuntimeUpdateVersion,
  type RemoteRuntimeUpdateAffectedWork,
  type RemoteRuntimeUpdateErrorCode,
  type RemoteRuntimeUpdateOperation,
  type RemoteRuntimeUpdateState,
  type RemoteRuntimeUpdateStatus,
} from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import type { StatusSurfaceTone } from "@bigbud/ui/statusSurface";
import * as Schema from "effect/Schema";
import type { BackendScopeState } from "../../rpc/backendScope.state";

/** Where the update UI may appear. Local windows never show it (the local backend refuses the
 * RPCs as `unauthorized`); a bound backend without the capability gets a typed explanation. */
export type RemoteBackendUpdateAvailability =
  | { readonly kind: "hidden" }
  | { readonly kind: "unsupported"; readonly backendVersion: string | null }
  | { readonly kind: "available"; readonly backendVersion: string };

export function resolveUpdateAvailability(
  scope: BackendScopeState,
  handshake: RemoteBackendClientHandshake | null,
): RemoteBackendUpdateAvailability {
  if (scope.kind !== "bound") return { kind: "hidden" };
  if (!handshake?.capabilities.runtimeUpdates)
    return { kind: "unsupported", backendVersion: handshake?.backendVersion ?? null };
  return { kind: "available", backendVersion: handshake.backendVersion };
}

export const TERMINAL_UPDATE_STATES: ReadonlyArray<RemoteRuntimeUpdateState> = [
  "activated",
  "failed",
  "cancelled",
];
/** Mirrors the server: consent is accepted once an archive is staged and before activation. */
export const CONSENTABLE_UPDATE_STATES: ReadonlyArray<RemoteRuntimeUpdateState> = [
  "staged",
  "awaiting-drain",
  "deferred",
];

export const isTerminalUpdateState = (state: RemoteRuntimeUpdateState) =>
  TERMINAL_UPDATE_STATES.includes(state);

/** A live operation blocks a new request; terminal ones are history. */
export function liveOperation(
  status: RemoteRuntimeUpdateStatus | null,
): RemoteRuntimeUpdateOperation | null {
  const operation = status?.operation ?? null;
  return operation && !isTerminalUpdateState(operation.state) ? operation : null;
}

const WORK_NOUNS: Record<RemoteRuntimeUpdateAffectedWork["kind"], [string, string]> = {
  turn: ["running turn", "running turns"],
  approval: ["pending approval", "pending approvals"],
  "user-input": ["question waiting for an answer", "questions waiting for an answer"],
  shell: ["running shell command", "running shell commands"],
  other: ["other running task", "other running tasks"],
};

/** Honest, countable reasons derived from the affected-work list the server reported. */
export function describeBlockingWork(
  work: ReadonlyArray<RemoteRuntimeUpdateAffectedWork>,
): string[] {
  const counts = new Map<RemoteRuntimeUpdateAffectedWork["kind"], number>();
  for (const item of work) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return (Object.keys(WORK_NOUNS) as Array<RemoteRuntimeUpdateAffectedWork["kind"]>)
    .filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind)!;
      return `${count} ${WORK_NOUNS[kind][count === 1 ? 0 : 1]}`;
    });
}

export interface UpdateStatePresentation {
  /** Blue while working, green when done, amber for deferral, red for failure. */
  readonly tone: Extract<StatusSurfaceTone, "info" | "loading" | "success" | "warning" | "error">;
  readonly title: string;
  readonly description: string;
  readonly reasons: ReadonlyArray<string>;
  readonly canCancel: boolean;
  readonly canInterrupt: boolean;
}

type StateCopy = Pick<UpdateStatePresentation, "tone" | "title" | "description">;

function stateCopy(
  operation: RemoteRuntimeUpdateOperation,
  reasons: ReadonlyArray<string>,
): StateCopy {
  const version = `bigbud ${operation.version}`;
  switch (operation.state) {
    case "pending":
      return {
        tone: "loading",
        title: "Update queued",
        description: `Waiting to prepare ${version}.`,
      };
    case "staging":
      return {
        tone: "loading",
        title: "Preparing update",
        description: `Downloading and verifying ${version}.`,
      };
    case "staged":
      return {
        tone: "loading",
        title: "Update ready",
        description: `${version} is staged. It installs once running work has finished.`,
      };
    case "awaiting-drain":
      return {
        tone: "loading",
        title: "Waiting for work to finish",
        description: `${version} installs when the backend is idle.`,
      };
    case "deferred":
      return {
        tone: "warning",
        title: "Update deferred",
        description:
          reasons.length > 0
            ? `${version} waits because work is still running on this backend.`
            : `${version} was deferred, but the backend did not report which work blocks it.`,
      };
    case "activating":
      return {
        tone: "loading",
        title: "Installing update",
        description: `The backend restarts on ${version}. This window reconnects on its own.`,
      };
    case "activated":
      return {
        tone: "success",
        title: "Update installed",
        description: `This backend now runs ${version}.`,
      };
    case "failed":
      return {
        tone: "error",
        title: "Update failed",
        description:
          operation.failure ??
          `${version} could not be installed. The backend keeps its current version.`,
      };
    case "cancelled":
      return {
        tone: "info",
        title: "Update cancelled",
        description: `${version} was not installed.`,
      };
  }
}

/** State machine → status copy and allowed actions. `null` means no operation was ever run. */
export function describeUpdateState(
  status: RemoteRuntimeUpdateStatus,
): UpdateStatePresentation | null {
  const operation = status.operation;
  if (!operation) return null;
  const reasons =
    operation.state === "deferred" || operation.state === "awaiting-drain"
      ? describeBlockingWork(status.affectedWork)
      : [];
  const canCancel = !isTerminalUpdateState(operation.state) && operation.state !== "activating";
  const canInterrupt =
    CONSENTABLE_UPDATE_STATES.includes(operation.state) &&
    status.affectedWork.length > 0 &&
    status.affectedWorkDigest !== null &&
    operation.consent !== "consumed";
  return { ...stateCopy(operation, reasons), reasons, canCancel, canInterrupt };
}

/** The target is this computer's bigbud version; the backend is offered an update to match it. */
export type UpdateTarget =
  | { readonly kind: "requestable"; readonly version: string }
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "invalid"; readonly version: string };

export function resolveUpdateTarget(localVersion: string, backendVersion: string): UpdateTarget {
  if (!Schema.is(RemoteRuntimeUpdateVersion)(localVersion))
    return { kind: "invalid", version: localVersion };
  if (localVersion === backendVersion) return { kind: "current", version: localVersion };
  return { kind: "requestable", version: localVersion };
}

export interface RemoteRuntimeUpdateFailure {
  readonly code: RemoteRuntimeUpdateErrorCode;
  readonly message: string;
}

/** Typed server refusal, or null for transport and unknown failures. */
export function readRemoteRuntimeUpdateFailure(error: unknown): RemoteRuntimeUpdateFailure | null {
  if (typeof error !== "object" || error === null) return null;
  const failure = error as { _tag?: unknown; code?: unknown; message?: unknown };
  if (failure._tag !== "RemoteRuntimeUpdateError" || typeof failure.code !== "string") return null;
  return {
    code: failure.code as RemoteRuntimeUpdateErrorCode,
    message: typeof failure.message === "string" ? failure.message : "",
  };
}

export function describeActionError(error: unknown): string {
  const typed = readRemoteRuntimeUpdateFailure(error);
  if (typed?.message) return typed.message;
  return error instanceof Error && error.message ? error.message : "The backend did not answer.";
}
