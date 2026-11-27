import { stat } from "node:fs/promises";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  commitLegacyRetirement,
  readLegacyRetirement,
} from "../persistence/Layers/LegacyRetirement.ts";
import {
  runSshOwnerBootSequence,
  type SshOwnerBootOutcome,
  type SshOwnerProductionOwner,
} from "./sshOwnerProductionBoot.ts";
import {
  listLegacyHostSshPanes,
  retireLegacyHostSshPanes,
  type LegacyHostSshPane,
} from "../terminal-host/localTerminalHost.retirementSource.ts";
import { TerminalHostRetirementUnsupportedError } from "../terminal-host/localTerminalHost.retirement.ts";
import { readSshOwnerHydrationSnapshot } from "./sshOwnerProductionHydration.ts";
import {
  makeSshLegacyStartupGate,
  readSshOwnerStartupState,
  type SshLegacyStartupGateShape,
  type SshOwnerStartupState,
} from "./sshOwnerStartupRefusal.ts";

/**
 * Production composition of the W3.6 B startup refusal. When activation is on,
 * every boot reads the retirement marker before any owner start; a fenced boot
 * keeps local work running, records a gate with the typed `legacyEntryFenced`
 * reason, and exposes `drainIdentified` as the **explicit** drain action. Startup
 * never drains or writes the marker by itself.
 *
 * `drainIdentified` closes the identified legacy panes the caller supplies, then
 * commits a Build B retirement record and reruns the boot. Panes left pending by
 * a previous drain cannot be settled here: the action fails and the fence stays.
 *
 * @module sshOwnerProductionStartup
 */

/** Artifact id written when the explicit B-side drain retires the profile. */
export const SSH_OWNER_EXPLICIT_DRAIN_ARTIFACT_ID = "bigbud-build-b-explicit-drain";

export class SshOwnerExplicitDrainError extends Data.TaggedError("SshOwnerExplicitDrainError")<{
  readonly reason:
    | "no-fence"
    | "legacy-panes-pending"
    | "host-exit-required"
    | "conflict"
    | "drain-failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A managed SSH pane on an attached X2 host; identity is never a guessed socket path. */
export type SshOwnerIdentifiedPane = LegacyHostSshPane;

export interface SshOwnerProductionStartupInput {
  readonly sql: SqlClient.SqlClient;
  /** Keys the owner's hydration rows (the state directory). */
  readonly profileScope: string;
  /** Keys the Build A marker; production passes `LEGACY_RETIREMENT_PROFILE_SCOPE`. */
  readonly legacyProfileScope: string;
  readonly artifactPath: string;
  readonly assertLockHeld: Effect.Effect<void, Error>;
  readonly startOwner: Effect.Effect<SshOwnerProductionOwner, Error>;
  /** Defaults to a stat of the verified artifact; a missing owner is `sshOwnerUnavailable`. */
  readonly ownerPresent?: Effect.Effect<boolean, Error>;
  /** Defaults to the attached X2 hosts' `inventory` verb (managed SSH panes only). */
  readonly listIdentifiedPanes?: Effect.Effect<ReadonlyArray<SshOwnerIdentifiedPane>, Error>;
  /** Defaults to the hosts' `retireSshSpawn` verb for exactly the listed leases. */
  readonly retireIdentifiedPanes?: (
    panes: ReadonlyArray<SshOwnerIdentifiedPane>,
  ) => Effect.Effect<void, Error>;
  /** Records every boot outcome, including the one after an explicit drain. */
  readonly onOutcome: (outcome: SshOwnerBootOutcome) => Effect.Effect<void>;
}

let gate: SshLegacyStartupGateShape | undefined;
let currentInput: SshOwnerProductionStartupInput | undefined;
let lastOutcome: SshOwnerBootOutcome | undefined;

export const readSshOwnerStartupGate = () => gate;

/** Test-only reset. */
export function resetSshOwnerStartupGateForTest(): void {
  gate = undefined;
  currentInput = undefined;
  lastOutcome = undefined;
}

const artifactPresent = (path: string) =>
  Effect.tryPromise({
    try: async () => (await stat(path)).isFile(),
    catch: (cause) => new Error("The SSH owner artifact could not be inspected.", { cause }),
  }).pipe(Effect.orElseSucceed(() => false));

const bootOnce = (input: SshOwnerProductionStartupInput) =>
  Effect.gen(function* () {
    let state: SshOwnerStartupState | undefined;
    const outcome = yield* runSshOwnerBootSequence({
      acquireStateLock: input.assertLockHeld,
      readState: readSshOwnerStartupState(input.sql, {
        profileScope: input.legacyProfileScope,
        ownerPresent: input.ownerPresent ?? artifactPresent(input.artifactPath),
      }).pipe(Effect.tap((read) => Effect.sync(() => void (state = read)))),
      startOrAttachOwner: input.startOwner,
      hydrate: (owner) =>
        readSshOwnerHydrationSnapshot(input.sql, input.profileScope).pipe(
          Effect.flatMap((snapshot) => owner.hydrate(snapshot)),
        ),
      openAdmission: () => Effect.void,
    });
    currentInput = input;
    gate = state
      ? makeSshLegacyStartupGate({ state, drainIdentified: () => drainIdentified(input) })
      : undefined;
    lastOutcome = outcome;
    yield* input.onOutcome(outcome);
    return outcome;
  });

const hostError = (cause: unknown) =>
  cause instanceof Error ? cause : new Error("The terminal host could not be reached.");

const listPanes = (input: SshOwnerProductionStartupInput) =>
  input.listIdentifiedPanes ??
  Effect.tryPromise({ try: () => listLegacyHostSshPanes(), catch: hostError });

const retirePanes = (
  input: SshOwnerProductionStartupInput,
  panes: ReadonlyArray<SshOwnerIdentifiedPane>,
) =>
  input.retireIdentifiedPanes?.(panes) ??
  Effect.tryPromise({ try: () => retireLegacyHostSshPanes(panes), catch: hostError });

const drainFailure = (cause: unknown) =>
  cause instanceof SshOwnerExplicitDrainError
    ? cause
    : cause instanceof TerminalHostRetirementUnsupportedError
      ? new SshOwnerExplicitDrainError({
          reason: "host-exit-required",
          message:
            "A running terminal host cannot retire SSH panes; quit it (or restart the computer) before draining. SSH stays fenced.",
          cause,
        })
      : new SshOwnerExplicitDrainError({
          reason: "drain-failed",
          message: "The explicit SSH drain failed; SSH stays fenced and local work continues.",
          cause,
        });

function drainIdentified(input: SshOwnerProductionStartupInput) {
  return Effect.gen(function* () {
    const existing = yield* readLegacyRetirement(input.sql, input.legacyProfileScope);
    if (existing && existing.record.pendingItems.length > 0)
      return yield* new SshOwnerExplicitDrainError({
        reason: "legacy-panes-pending",
        message:
          "A previous drain left SSH panes pending that this build cannot close; SSH stays fenced.",
      });
    if (existing)
      return yield* new SshOwnerExplicitDrainError({
        reason: "no-fence",
        message: "The retirement marker is already recorded; there is nothing to drain.",
      });
    // Cutover §c step 3: list on the host, retire exactly those leases, then write.
    const panes = yield* listPanes(input);
    yield* retirePanes(input, panes);
    const written = yield* commitLegacyRetirement(input.sql, {
      profileScope: input.legacyProfileScope,
      artifactId: SSH_OWNER_EXPLICIT_DRAIN_ARTIFACT_ID,
      decision: "drain-now",
      drainedLeases: panes.map((pane) => pane.identity),
      pendingItems: [],
    });
    if (written === "conflict")
      return yield* new SshOwnerExplicitDrainError({
        reason: "conflict",
        message: "Another build already retired this profile with a different record.",
      });
    yield* bootOnce(input);
  }).pipe(Effect.mapError(drainFailure));
}

/** One production boot. Never drains by itself; a fenced boot leaves the explicit action. */
export const runSshOwnerProductionStartup = Effect.fn("runSshOwnerProductionStartup")(function* (
  input: SshOwnerProductionStartupInput & { readonly drainRequested?: boolean },
) {
  const outcome = yield* bootOnce(input);
  if (outcome.kind !== "refused" || !input.drainRequested) return outcome;
  yield* Effect.logInfo("Running the explicitly requested SSH legacy drain", {
    reason: outcome.error.reason,
  });
  const drained = yield* Effect.exit(drainSshOwnerIdentifiedPanes());
  if (drained._tag === "Failure")
    yield* Effect.logWarning("The explicit SSH legacy drain failed; SSH stays fenced", {
      cause: drained.cause,
    });
  return lastOutcome ?? outcome;
});

/** The explicit user drain action on the current gate. */
export const drainSshOwnerIdentifiedPanes = (): Effect.Effect<void, SshOwnerExplicitDrainError> =>
  gate && gate.state.kind === "refused"
    ? gate.drainIdentified().pipe(Effect.mapError(drainFailure))
    : Effect.fail(
        new SshOwnerExplicitDrainError({
          reason: "no-fence",
          message: "SSH is not fenced by a missing drain; there is nothing to drain.",
        }),
      );

/** Panes the explicit drain would retire, for the consent UI; empty unless fenced. */
export const listSshOwnerIdentifiedPanes = (): Effect.Effect<
  ReadonlyArray<SshOwnerIdentifiedPane>,
  SshOwnerExplicitDrainError
> =>
  gate?.state.kind === "refused" && currentInput
    ? listPanes(currentInput).pipe(Effect.mapError(drainFailure))
    : Effect.succeed([]);
