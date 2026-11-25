import * as Effect from "effect/Effect";

import type { SshOwnerProfile } from "./sshOwnerProductionArtifact.ts";
import type { SshOwnerHydrationSnapshot } from "./sshOwnerProductionHydration.ts";
import {
  LegacyEntryFencedError,
  SshOwnerUnavailableError,
  type SshOwnerStartupState,
  type SshOwnerUnavailableReason,
} from "./sshOwnerStartupRefusal.ts";

/**
 * B boot order (cutover §c), gated by the build-time activation constant:
 *
 *   1. acquire (or re-assert) `backend.lock`
 *   2. read the Build A retirement marker (W3.6 gate)
 *   3. start or attach the owner under the exclusive owner fence
 *   4. hydrate durable disconnects, alias bindings, the retirement mirror and
 *      pane bindings into the owner
 *   5. only then open SSH admission
 *
 * Any failure leaves admission closed with a typed reason and local features
 * keep working. No step after a refusal is evaluated, so a refused startup
 * launches no SSH.
 *
 * @module sshOwnerProductionBoot
 */

export type SshOwnerBootStep =
  | "state-lock"
  | "retirement-marker"
  | "owner-attach"
  | "hydrate"
  | "admission";

export interface SshOwnerProductionOwner {
  readonly profile: SshOwnerProfile;
  readonly artifactPath: string;
  readonly hydrate: (snapshot: SshOwnerHydrationSnapshot) => Effect.Effect<void, Error>;
}

export type SshOwnerBootOutcome =
  | { readonly kind: "open"; readonly owner: SshOwnerProductionOwner }
  | { readonly kind: "refused"; readonly error: LegacyEntryFencedError }
  | {
      readonly kind: "unavailable";
      readonly step: SshOwnerBootStep;
      readonly error: SshOwnerUnavailableError;
    };

export interface SshOwnerBootInput {
  /** The lock is already held by `StateDirLockLive`; this step re-asserts it. */
  readonly acquireStateLock: Effect.Effect<void, Error>;
  readonly readState: Effect.Effect<SshOwnerStartupState, Error>;
  readonly startOrAttachOwner: Effect.Effect<SshOwnerProductionOwner, Error>;
  readonly hydrate: (owner: SshOwnerProductionOwner) => Effect.Effect<void, Error>;
  readonly openAdmission: (owner: SshOwnerProductionOwner) => Effect.Effect<void, Error>;
}

const closed = (
  step: SshOwnerBootStep,
  reason: SshOwnerUnavailableReason,
  message: string,
): SshOwnerBootOutcome => ({
  kind: "unavailable",
  step,
  error: new SshOwnerUnavailableError({ code: "sshOwnerUnavailable", reason, message }),
});

const unavailableFrom = (
  step: SshOwnerBootStep,
  reason: SshOwnerUnavailableReason,
  cause: unknown,
): SshOwnerBootOutcome => {
  if (cause instanceof SshOwnerUnavailableError) {
    return { kind: "unavailable", step, error: cause };
  }
  if (cause instanceof LegacyEntryFencedError) {
    return { kind: "refused", error: cause };
  }
  const detail = cause instanceof Error ? cause.message : "unknown failure";
  return closed(step, reason, `SSH admission stayed closed: ${detail}`);
};

export const runSshOwnerBootSequence = Effect.fn("runSshOwnerBootSequence")(
  (input: SshOwnerBootInput): Effect.Effect<SshOwnerBootOutcome> =>
    Effect.gen(function* () {
      const locked = yield* Effect.exit(input.acquireStateLock);
      if (locked._tag === "Failure") {
        return unavailableFrom("state-lock", "state-lock-failed", locked.cause);
      }

      const state = yield* Effect.exit(input.readState);
      if (state._tag === "Failure") {
        return unavailableFrom("retirement-marker", "retirement-read-failed", state.cause);
      }
      if (state.value.kind === "refused") {
        return { kind: "refused", error: state.value.error } satisfies SshOwnerBootOutcome;
      }
      if (state.value.kind === "ssh-unavailable") {
        return {
          kind: "unavailable",
          step: "owner-attach",
          error: state.value.error,
        } satisfies SshOwnerBootOutcome;
      }

      const started = yield* Effect.exit(input.startOrAttachOwner);
      if (started._tag === "Failure") {
        return unavailableFrom("owner-attach", "owner-start-failed", started.cause);
      }
      const owner = started.value;

      const hydrated = yield* Effect.exit(input.hydrate(owner));
      if (hydrated._tag === "Failure") {
        return unavailableFrom("hydrate", "hydration-failed", hydrated.cause);
      }

      const admitted = yield* Effect.exit(input.openAdmission(owner));
      if (admitted._tag === "Failure") {
        return unavailableFrom("admission", "admission-failed", admitted.cause);
      }

      return { kind: "open", owner } satisfies SshOwnerBootOutcome;
    }),
);
