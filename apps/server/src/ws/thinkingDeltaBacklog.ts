/**
 * Per-client bound for the thinking-preview delta stream (F-B1).
 *
 * Every WebSocket client subscribes to the shared provider runtime-event PubSub to receive
 * thinking deltas. A slow client used to hold its PubSub subscription back, so the PubSub kept
 * every event for it without limit. This wrapper drains the subscription on its own fiber into a
 * dropping queue of {@link THINKING_DELTA_CLIENT_BACKLOG_CAPACITY} deltas, so the shared PubSub
 * never waits on a slow client.
 *
 * Thinking deltas are a live preview only: the persisted thinking activity is written by
 * ingestion from the same provider events and replaces the preview on reconcile. A dropped delta
 * therefore loses no durable data. The next delta that fits for the same activity carries
 * {@link THINKING_DELTA_GAP_MARKER} in front of its text, so the preview shows where text is
 * missing instead of splicing two distant fragments together.
 *
 * @module thinkingDeltaBacklog
 */
import type { ThinkingActivityDeltaEvent } from "@bigbud/contracts";
import { Effect, Queue, Stream } from "effect";

/** Deltas buffered per client before newer deltas are dropped (with a gap marker). */
export const THINKING_DELTA_CLIENT_BACKLOG_CAPACITY = 512;

/** Prepended to the first delivered delta of an activity after one or more were dropped. */
export const THINKING_DELTA_GAP_MARKER = "\n\n[... thinking preview gap ...]\n\n";

export function boundThinkingDeltaBacklog<E, R>(
  source: Stream.Stream<ThinkingActivityDeltaEvent, E, R>,
  capacity: number = THINKING_DELTA_CLIENT_BACKLOG_CAPACITY,
): Stream.Stream<ThinkingActivityDeltaEvent, E, R> {
  return Stream.callback<ThinkingActivityDeltaEvent, E, R>(
    (queue) => {
      // Activities that lost at least one delta since their last delivered delta.
      const gaps = new Set<string>();
      const offer = (event: ThinkingActivityDeltaEvent) => {
        const gapped = gaps.has(event.activityId);
        const next = gapped
          ? { ...event, delta: `${THINKING_DELTA_GAP_MARKER}${event.delta}` }
          : event;
        return Queue.offer(queue, next).pipe(
          Effect.map((accepted) => {
            if (accepted) gaps.delete(event.activityId);
            else gaps.add(event.activityId);
          }),
        );
      };
      return Stream.runForEach(source, offer).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => Queue.failCause(queue, cause),
          onSuccess: () => Queue.end(queue),
        }),
        Effect.forkScoped,
      );
    },
    { bufferSize: capacity, strategy: "dropping" },
  );
}
