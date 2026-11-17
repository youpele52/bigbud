import {
  RemoteRuntimeUpdateError,
  type RemoteRuntimeUpdateErrorCode,
  type RemoteRuntimeUpdateOperation,
  type RemoteRuntimeUpdateState,
} from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import type { RemoteRuntimeUpdateRecord } from "../persistence/Services/RemoteRuntimeUpdateOperations.ts";

/**
 * The update operation's state machine (WP-4C). WP-4C drives pending → staging → staged and
 * cancellation; WP-4D drives staged → awaiting-drain ⇄ deferred → activating → activated/failed.
 */
export const RUNTIME_UPDATE_TRANSITIONS: Readonly<
  Record<RemoteRuntimeUpdateState, ReadonlyArray<RemoteRuntimeUpdateState>>
> = {
  pending: ["staging", "failed", "cancelled"],
  staging: ["staged", "failed", "cancelled"],
  staged: ["awaiting-drain", "failed", "cancelled"],
  "awaiting-drain": ["activating", "deferred", "failed", "cancelled"],
  deferred: ["awaiting-drain", "failed", "cancelled"],
  // Once activating, only WP-4D's activation/rollback may settle it; it is never cancelled.
  activating: ["activated", "failed"],
  activated: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_RUNTIME_UPDATE_STATES: ReadonlyArray<RemoteRuntimeUpdateState> = [
  "activated",
  "failed",
  "cancelled",
];
/** States in which staging owns the operation (and resumes it after a restart). */
export const STAGING_RUNTIME_UPDATE_STATES: ReadonlyArray<RemoteRuntimeUpdateState> = [
  "pending",
  "staging",
];
/** A staged archive is waiting for drain/activation; interruption consent may be given here. */
export const CONSENTABLE_RUNTIME_UPDATE_STATES: ReadonlyArray<RemoteRuntimeUpdateState> = [
  "staged",
  "awaiting-drain",
  "deferred",
];

export const isTerminalRuntimeUpdateState = (state: RemoteRuntimeUpdateState) =>
  TERMINAL_RUNTIME_UPDATE_STATES.includes(state);

/** States from which `to` is a legal transition. */
export function runtimeUpdateSourcesFor(
  to: RemoteRuntimeUpdateState,
): ReadonlyArray<RemoteRuntimeUpdateState> {
  return (Object.keys(RUNTIME_UPDATE_TRANSITIONS) as Array<RemoteRuntimeUpdateState>).filter(
    (from) => RUNTIME_UPDATE_TRANSITIONS[from].includes(to),
  );
}

export const runtimeUpdateError = (code: RemoteRuntimeUpdateErrorCode, message: string) =>
  new RemoteRuntimeUpdateError({ code, message });

/** Bounded, single-line failure text; never raw paths beyond what the store already reports. */
export function runtimeUpdateFailureText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : "Runtime update staging failed.";
  // oxlint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1024) || "Staging failed.";
}

/** Client view; request id, archive key and consent digest stay server-side. */
export function toRuntimeUpdateView(
  record: RemoteRuntimeUpdateRecord,
): RemoteRuntimeUpdateOperation {
  return {
    operationId: record.operationId,
    version: record.version,
    source: record.source,
    state: record.state,
    interruptRequested: record.interruptRequested,
    consent: record.consentState,
    failure: record.failure,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
