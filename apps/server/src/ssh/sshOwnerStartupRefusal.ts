import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  readLegacyRetirement,
  type LegacyRetirementMarker,
  type LegacyRetirementRecord,
} from "../persistence/Layers/LegacyRetirement.ts";

/**
 * Build B startup refusal (W3.6). Before persistence writers and before any owner
 * starts, B reads the Build A retirement marker. A missing marker means A was not
 * drained (crash or unsupported path); B keeps local features available, closes SSH
 * admission with the typed `legacyEntryFenced`, and offers an explicit drain action.
 *
 * Retirement is never inferred from an idle interval, a missing socket or an absent
 * process, and a fenced startup never clears or retries anything by itself.
 *
 * @module sshOwnerStartupRefusal
 */

export const SSH_LEGACY_ENTRY_FENCED_CODE = "legacyEntryFenced";

export type LegacyEntryFencedReason = "retirement-marker-missing" | "legacy-panes-pending";

export class LegacyEntryFencedError extends Data.TaggedError("LegacyEntryFencedError")<{
  readonly code: typeof SSH_LEGACY_ENTRY_FENCED_CODE;
  readonly reason: LegacyEntryFencedReason;
  readonly message: string;
}> {
  constructor(reason: LegacyEntryFencedReason) {
    super({
      code: SSH_LEGACY_ENTRY_FENCED_CODE,
      reason,
      message:
        reason === "retirement-marker-missing"
          ? "This backend cannot use SSH yet: the previous version did not record a completed drain. Local work continues; drain the identified SSH panes to continue."
          : "This backend cannot use SSH yet: the previous drain left identified panes pending. Local work continues; drain the identified SSH panes to continue.",
    });
  }
}

export type SshOwnerUnavailableReason =
  | "owner-missing"
  | "owner-unverified"
  | "owner-incompatible"
  | "owner-profile-unavailable"
  | "owner-profile-missing"
  | "owner-profile-not-canonical"
  | "owner-profile-not-directory"
  | "owner-profile-unexpected-boundary"
  | "owner-profile-unsafe"
  | "owner-profile-mismatch"
  | "owner-startup-timeout"
  | "owner-version-incompatible"
  | "owner-capability-missing"
  | "owner-protocol-invalid"
  | "owner-second-instance"
  | "owner-died"
  | "state-lock-failed"
  | "retirement-read-failed"
  | "owner-start-failed"
  | "hydration-failed"
  | "admission-failed";

export class SshOwnerUnavailableError extends Data.TaggedError("SshOwnerUnavailableError")<{
  /** Distinct from `legacyEntryFenced` and from a schema-too-new refusal. */
  readonly code: "sshOwnerUnavailable";
  readonly reason: SshOwnerUnavailableReason;
  readonly message: string;
}> {}

export type SshOwnerStartupState =
  | {
      readonly kind: "admitted";
      readonly marker: LegacyRetirementMarker;
      readonly record: LegacyRetirementRecord;
    }
  | { readonly kind: "refused"; readonly error: LegacyEntryFencedError }
  | { readonly kind: "ssh-unavailable"; readonly error: SshOwnerUnavailableError };

export interface SshOwnerStartupRefusalInput {
  readonly profileScope: string;
  /** Effect so the check may stat a verified owner artifact without spawning it. */
  readonly ownerPresent: Effect.Effect<boolean, Error>;
}

/**
 * Reads the marker and record before the owner starts. The caller supplies the
 * owner-presence fact; a missing owner after a valid marker is SSH-unavailable,
 * not a legacy fence.
 */
export const readSshOwnerStartupState = Effect.fn("readSshOwnerStartupState")(function* (
  sql: SqlClient.SqlClient,
  input: SshOwnerStartupRefusalInput,
) {
  const retirement = yield* readLegacyRetirement(sql, input.profileScope);
  if (!retirement)
    return {
      kind: "refused",
      error: new LegacyEntryFencedError("retirement-marker-missing"),
    } satisfies SshOwnerStartupState;
  if (retirement.record.pendingItems.length > 0)
    return {
      kind: "refused",
      error: new LegacyEntryFencedError("legacy-panes-pending"),
    } satisfies SshOwnerStartupState;
  const ownerPresent = yield* input.ownerPresent.pipe(Effect.orElseSucceed(() => false));
  if (!ownerPresent)
    return {
      kind: "ssh-unavailable",
      error: new SshOwnerUnavailableError({
        code: "sshOwnerUnavailable",
        reason: "owner-missing",
        message: "The verified SSH owner is missing; local work continues.",
      }),
    } satisfies SshOwnerStartupState;
  return {
    kind: "admitted",
    marker: retirement.marker,
    record: retirement.record,
  } satisfies SshOwnerStartupState;
});

/**
 * Starts the owner only after an admitted state. Every refusal path returns
 * `Option.none` without evaluating `startOwner`, so zero SSH is launched.
 */
export const startSshOwnerAfterLegacyGate = <A, E, R>(input: {
  readonly readState: Effect.Effect<SshOwnerStartupState, E, R>;
  readonly startOwner: Effect.Effect<A, E, R>;
  readonly onRefused: (error: LegacyEntryFencedError) => Effect.Effect<void, never, R>;
  readonly onUnavailable: (state: SshOwnerUnavailableError) => Effect.Effect<void, never, R>;
}) =>
  Effect.gen(function* () {
    const state = yield* input.readState;
    if (state.kind === "refused") {
      yield* input.onRefused(state.error);
      return Option.none<A>();
    }
    if (state.kind === "ssh-unavailable") {
      yield* input.onUnavailable(state.error);
      return Option.none<A>();
    }
    return Option.some(yield* input.startOwner);
  });

export interface SshLegacyStartupGateShape {
  readonly state: SshOwnerStartupState;
  /** Fails closed with the typed fence or availability error. */
  readonly assertSshAdmission: Effect.Effect<
    void,
    LegacyEntryFencedError | SshOwnerUnavailableError
  >;
  /** The explicit user action; never invoked by startup itself. */
  readonly drainIdentified: () => Effect.Effect<void, Error>;
}

/**
 * Wraps a state and the explicit W3.2 drain. `drainIdentified` exists for the UI
 * action only; constructing the gate runs nothing.
 */
export function makeSshLegacyStartupGate(input: {
  readonly state: SshOwnerStartupState;
  readonly drainIdentified: () => Effect.Effect<void, Error>;
}): SshLegacyStartupGateShape {
  return {
    state: input.state,
    assertSshAdmission:
      input.state.kind === "admitted" ? Effect.void : Effect.fail(input.state.error),
    drainIdentified: input.drainIdentified,
  };
}
