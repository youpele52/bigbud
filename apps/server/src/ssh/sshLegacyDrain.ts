import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * U5/U8 A-side drain-on-quit. It runs only for a supported upgrade trigger and in
 * the plan's order: stop monitors, relays and providers; ask for consent with the
 * pane list; mark the drained panes closed without respawn; exit A's own SSH
 * masters; write the retirement record and marker in one transaction; checkpoint
 * the WAL; and only then release the backend lock.
 *
 * Any failure before the commit leaves the lock held and writes no marker, so a
 * crash leaves A refusing rather than half-drained. Re-running is safe: pane
 * closes and the retirement write are idempotent.
 *
 * @module sshLegacyDrain
 */

export type LegacyDrainTrigger = "installer" | "updater" | "cli-for-upgrade";
export type LegacyDrainSurface = "direct-ssh" | "local" | "remote-agent";
export type LegacyDrainChoice = "save-and-close" | "drain-now";

export interface LegacyDrainPane {
  readonly paneId: string;
  /** Stable thread identity shown in the consent list. */
  readonly threadId: string;
  readonly threadTitle: string;
  readonly title: string;
  readonly surface: LegacyDrainSurface;
  /** Exact native/PTY lease when the pane has one; never a guessed socket path. */
  readonly leaseId?: string;
  /** U6: remote-agent terminals honour keep mode; direct SSH panes never do. */
  readonly keepMode: boolean;
}

export type LegacyDrainConsent =
  | { readonly kind: "cancel" }
  | { readonly kind: "proceed"; readonly choice: LegacyDrainChoice };

export interface LegacyDrainOutcome {
  readonly kind: "unsupported" | "cancelled" | "drained";
  readonly drained: ReadonlyArray<LegacyDrainPane>;
  readonly preserved: ReadonlyArray<LegacyDrainPane>;
}

interface DrainedPhase {
  readonly kind: "drained";
  readonly decision: LegacyDrainChoice;
  readonly drained: ReadonlyArray<LegacyDrainPane>;
  readonly preserved: ReadonlyArray<LegacyDrainPane>;
}

interface CancelledPhase {
  readonly kind: "cancelled";
  readonly drained: ReadonlyArray<LegacyDrainPane>;
  readonly preserved: ReadonlyArray<LegacyDrainPane>;
}

export type LegacyDrainStage = "stop" | "list" | "close" | "masters" | "commit" | "release";

export class LegacyDrainError extends Data.TaggedError("LegacyDrainError")<{
  readonly stage: LegacyDrainStage;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface LegacyDrainInput {
  readonly trigger: LegacyDrainTrigger;
  readonly profileScope: string;
  readonly artifactId: string;
  readonly stopMonitors: Effect.Effect<void, Error>;
  readonly stopRelays: Effect.Effect<void, Error>;
  readonly stopProviders: Effect.Effect<void, Error>;
  readonly listPanes: Effect.Effect<ReadonlyArray<LegacyDrainPane>, Error>;
  readonly consent: (
    panes: ReadonlyArray<LegacyDrainPane>,
  ) => Effect.Effect<LegacyDrainConsent, Error>;
  /** Persists pane state for "save and close"; unused by "drain now". */
  readonly savePane?: ((pane: LegacyDrainPane) => Effect.Effect<void, Error>) | undefined;
  /** Marks the pane closed and guarantees no respawn. */
  readonly closePane: (pane: LegacyDrainPane) => Effect.Effect<void, Error>;
  /** `ssh -O exit` for A's own masters only; never discovered from ambient sockets. */
  readonly closeOwnedMasters: Effect.Effect<
    { readonly closed: number; readonly failed: number },
    Error
  >;
  readonly commit: (input: {
    readonly profileScope: string;
    readonly artifactId: string;
    readonly decision: LegacyDrainChoice;
    readonly drainedLeases: ReadonlyArray<string>;
    readonly pendingItems: ReadonlyArray<string>;
  }) => Effect.Effect<"committed" | "already-retired" | "conflict" | void, Error>;
  /** Called only after the marker is durably committed and the WAL is checkpointed. */
  readonly releaseLock: Effect.Effect<void, Error>;
  readonly timeoutMs?: number;
}

const SUPPORTED = new Set<LegacyDrainTrigger>(["installer", "updater", "cli-for-upgrade"]);

/** Direct SSH panes always drain; local panes are untouched; remote-agent panes keep U6. */
export const drainablePanes = (panes: ReadonlyArray<LegacyDrainPane>) =>
  panes.filter((pane) => {
    switch (pane.surface) {
      case "direct-ssh":
        return true;
      case "local":
        return false;
      case "remote-agent":
        return !pane.keepMode;
    }
  });

const stablePaneIdentity = (pane: LegacyDrainPane) =>
  pane.leaseId ?? `${pane.threadId}:${pane.paneId}`;

const fail = (stage: LegacyDrainStage, detail: string, cause?: unknown) =>
  new LegacyDrainError({ stage, detail, cause });

const stopPhase = (input: LegacyDrainInput) =>
  Effect.gen(function* () {
    yield* input.stopMonitors;
    yield* input.stopRelays;
    yield* input.stopProviders;
  }).pipe(
    Effect.mapError((cause) =>
      fail("stop", "Stopping monitors, relays or providers failed.", cause),
    ),
  );

/**
 * Runs the whole drain. The supported-trigger check happens before anything is
 * stopped, so a normal quit can never drain.
 */
export const runLegacyDrain = Effect.fn("runLegacyDrain")(function* (input: LegacyDrainInput) {
  if (!SUPPORTED.has(input.trigger))
    return { kind: "unsupported", drained: [], preserved: [] } as LegacyDrainOutcome;

  const drained: LegacyDrainPane[] = [];
  const preserved: LegacyDrainPane[] = [];
  const deadline = input.timeoutMs ?? 15_000;

  const beforeCommit: Effect.Effect<CancelledPhase | DrainedPhase, LegacyDrainError> = Effect.gen(
    function* () {
      yield* stopPhase(input);
      const panes = yield* input.listPanes.pipe(
        Effect.mapError((cause) => fail("list", "Listing terminals for the drain failed.", cause)),
      );
      const drain = drainablePanes(panes);
      drained.push(...drain);
      preserved.push(...panes.filter((pane) => !drain.includes(pane)));
      const decision = yield* input
        .consent(panes)
        .pipe(Effect.mapError((cause) => fail("list", "The drain consent UI failed.", cause)));
      if (decision.kind === "cancel")
        return { kind: "cancelled", drained: [], preserved } as CancelledPhase;

      for (const pane of drain) {
        if (decision.choice === "save-and-close" && input.savePane)
          yield* input
            .savePane(pane)
            .pipe(
              Effect.mapError((cause) =>
                fail("close", `Saving pane ${stablePaneIdentity(pane)} failed.`, cause),
              ),
            );
        yield* input
          .closePane(pane)
          .pipe(
            Effect.mapError((cause) =>
              fail("close", `Closing pane ${stablePaneIdentity(pane)} failed.`, cause),
            ),
          );
      }

      const masters = yield* input.closeOwnedMasters.pipe(
        Effect.mapError((cause) => fail("masters", "Closing A's SSH masters failed.", cause)),
      );
      if (masters.failed > 0)
        return yield* fail(
          "masters",
          `${masters.failed} SSH master${masters.failed === 1 ? "" : "s"} did not exit.`,
        );

      return {
        kind: "drained",
        decision: decision.choice,
        drained: drain,
        preserved,
      } as const;
    },
  ).pipe(
    Effect.timeoutOrElse({
      duration: deadline,
      orElse: () => Effect.fail(fail("close", `The drain did not finish within ${deadline} ms.`)),
    }),
  );

  const phase = yield* beforeCommit;
  if (phase.kind !== "drained") return phase;

  const written = yield* input
    .commit({
      profileScope: input.profileScope,
      artifactId: input.artifactId,
      decision: phase.decision,
      drainedLeases: phase.drained.map(stablePaneIdentity),
      pendingItems: [],
    })
    .pipe(
      Effect.mapError((cause) => fail("commit", "Writing the retirement marker failed.", cause)),
    );
  if (written === "conflict")
    return yield* fail("commit", "A different Build A artifact already retired this profile.");

  yield* input.releaseLock.pipe(
    Effect.mapError((cause) => fail("release", "Releasing the backend lock failed.", cause)),
  );
  return {
    kind: "drained",
    drained: phase.drained,
    preserved: phase.preserved,
  } satisfies LegacyDrainOutcome;
});
