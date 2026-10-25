import type { ServerLifecycleStreamEvent } from "@bigbud/contracts";
import { Effect, Layer, PubSub, Ref, ServiceMap, Stream } from "effect";

type LifecycleEventInput =
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "welcome" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "ready" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "stalled" }>, "sequence">;

/**
 * A stall is reported when it ends, often just as the old socket dies. The
 * latest stall stays in the snapshot this long so a reconnecting renderer can
 * still attribute its drop; older stalls are left to the diagnostics read RPC.
 */
export const LIFECYCLE_STALL_SNAPSHOT_TTL_MS = 120_000;

const isRecentStall = (event: ServerLifecycleStreamEvent, nowMs: number): boolean =>
  event.type !== "stalled" ||
  nowMs - Date.parse(event.payload.endedAt) <= LIFECYCLE_STALL_SNAPSHOT_TTL_MS;

interface SnapshotState {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleStreamEvent>;
}

export interface ServerLifecycleEventsShape {
  readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleStreamEvent>;
  readonly snapshot: Effect.Effect<SnapshotState>;
  readonly stream: Stream.Stream<ServerLifecycleStreamEvent>;
}

export class ServerLifecycleEvents extends ServiceMap.Service<
  ServerLifecycleEvents,
  ServerLifecycleEventsShape
>()("t3/serverLifecycleEvents") {}

export const ServerLifecycleEventsLive = Layer.effect(
  ServerLifecycleEvents,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
    const state = yield* Ref.make<SnapshotState>({
      sequence: 0,
      events: [],
    });

    return {
      publish: (event) =>
        Ref.modify(state, (current) => {
          const nextSequence = current.sequence + 1;
          const nextEvent = {
            ...event,
            sequence: nextSequence,
          } satisfies ServerLifecycleStreamEvent;
          // Each type keeps only its latest event, so a stall never evicts welcome or ready.
          const nextEvents = [
            nextEvent,
            ...current.events.filter((entry) => entry.type !== nextEvent.type),
          ];
          return [nextEvent, { sequence: nextSequence, events: nextEvents }] as const;
        }).pipe(Effect.tap((event) => PubSub.publish(pubsub, event))),
      snapshot: Ref.get(state).pipe(
        Effect.map((current) => {
          const nowMs = Date.now();
          return {
            sequence: current.sequence,
            events: current.events.filter((event) => isRecentStall(event, nowMs)),
          };
        }),
      ),
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies ServerLifecycleEventsShape;
  }),
);
