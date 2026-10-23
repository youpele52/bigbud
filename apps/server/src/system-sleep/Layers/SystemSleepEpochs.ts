import { Effect, Layer, Option, PubSub, Ref, Stream } from "effect";

import {
  addSleepEvidence,
  findSleepEpochAt,
  initialSleepEpochState,
  latestSleepEpoch,
  type SleepEpochState,
  type SleepEvidence,
} from "../SystemSleepEpochs.logic.ts";
import {
  applyDesktopHint,
  initialDesktopHintState,
  observeSupervisorSuspendedMillis,
  type DesktopHintState,
  type SupervisorClockState,
} from "../SystemSleepEpochs.sources.logic.ts";
import {
  SystemSleepEpochs,
  type SystemSleepEpochsShape,
  type SystemSleepEvent,
} from "../Services/SystemSleepEpochs.ts";

interface State {
  readonly epochs: SleepEpochState;
  readonly desktop: DesktopHintState;
  readonly supervisor: SupervisorClockState | null;
}

export const makeSystemSleepEpochs = Effect.fn("makeSystemSleepEpochs")(function* () {
  const pubsub = yield* PubSub.unbounded<SystemSleepEvent>();
  const state = yield* Ref.make<State>({
    epochs: initialSleepEpochState,
    desktop: initialDesktopHintState,
    supervisor: null,
  });

  const publish = (events: ReadonlyArray<SystemSleepEvent>) =>
    Effect.forEach(events, (event) => PubSub.publish(pubsub, event), { discard: true });

  const addEvidence = (current: State, evidence: SleepEvidence) => {
    const result = addSleepEvidence(current.epochs, evidence);
    const events: SystemSleepEvent[] = result.opened
      ? [{ type: "epoch-ended", epoch: result.epoch }]
      : [];
    return { next: { ...current, epochs: result.state }, events, epoch: result.epoch };
  };

  const logEpoch = (evidence: SleepEvidence, events: ReadonlyArray<SystemSleepEvent>) =>
    events.some((event) => event.type === "epoch-ended")
      ? Effect.logInfo("system sleep epoch opened", {
          source: evidence.source,
          startedAt: new Date(evidence.startedAtMs).toISOString(),
          endedAt: new Date(evidence.endedAtMs).toISOString(),
        })
      : Effect.void;

  const recordEvidence: SystemSleepEpochsShape["recordEvidence"] = (evidence) =>
    Ref.modify(state, (current) => {
      const { next, events } = addEvidence(current, evidence);
      return [events, next] as const;
    }).pipe(
      Effect.tap((events) => logEpoch(evidence, events)),
      Effect.flatMap(publish),
    );

  const recordDesktopHint: SystemSleepEpochsShape["recordDesktopHint"] = (hint) =>
    Ref.modify(state, (current) => {
      const applied = applyDesktopHint(current.desktop, hint);
      let next: State = { ...current, desktop: applied.state };
      const events: SystemSleepEvent[] = [];
      if (applied.evidence) {
        const added = addEvidence(next, applied.evidence);
        next = added.next;
        events.push(...added.events);
      }
      if (applied.networkOnline) {
        events.push({ type: "network-online", occurredAtMs: hint.occurredAt });
      }
      return [events, next] as const;
    }).pipe(Effect.flatMap(publish));

  const recordSupervisorSuspendedMillis: SystemSleepEpochsShape["recordSupervisorSuspendedMillis"] =
    (input) =>
      Ref.modify(state, (current) => {
        const observed = observeSupervisorSuspendedMillis(
          current.supervisor,
          input.suspendedMillis,
          input.observedAtMs,
        );
        const withClock: State = { ...current, supervisor: observed.state };
        if (!observed.evidence) return [[] as SystemSleepEvent[], withClock] as const;
        const added = addEvidence(withClock, observed.evidence);
        return [added.events, added.next] as const;
      }).pipe(Effect.flatMap(publish));

  const epochs = Ref.get(state).pipe(Effect.map((current) => current.epochs.epochs));

  return {
    recordEvidence,
    recordDesktopHint,
    recordSupervisorSuspendedMillis,
    latest: epochs.pipe(Effect.map((all) => Option.fromUndefinedOr(latestSleepEpoch(all)))),
    epochs,
    epochAt: (atMs) =>
      epochs.pipe(Effect.map((all) => Option.fromUndefinedOr(findSleepEpochAt(all, atMs)))),
    isWithinSleepWindow: (atMs) =>
      epochs.pipe(Effect.map((all) => findSleepEpochAt(all, atMs) !== undefined)),
    networkOnline: Ref.get(state).pipe(Effect.map((current) => current.desktop.online)),
    get events() {
      return Stream.fromPubSub(pubsub);
    },
  } satisfies SystemSleepEpochsShape;
});

export const SystemSleepEpochsLive = Layer.effect(SystemSleepEpochs, makeSystemSleepEpochs());
