import type { TerminalEventsStreamItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { Effect, Queue } from "effect";
import type * as Cause from "effect/Cause";

/** Soft output budget: global output only supports legacy remote agent detection. */
export const TERMINAL_EVENTS_OUTPUT_BACKLOG_LIMITS = {
  chars: 1024 * 1024,
  items: 1024,
  /** Hard budgets include lifecycle snapshots and all other event types. */
  totalChars: 4 * 1024 * 1024,
  totalItems: 2048,
} as const;

/**
 * Drop optional output at the soft limit. Lossless overflow ends this subscriber so the transport
 * backs off, resubscribes, and replays current manager state. Never block other subscribers/PTYs.
 * The bound covers both the queue and one bounded chunk already handed to the RPC transport.
 */
export function makeBoundedTerminalEventOffer<T extends TerminalEventsStreamItem>(
  queue: Queue.Queue<T, Cause.Done>,
  limits: {
    readonly chars: number;
    readonly items: number;
    readonly totalChars?: number;
    readonly totalItems?: number;
  } = TERMINAL_EVENTS_OUTPUT_BACKLOG_LIMITS,
): (event: T) => Effect.Effect<void> {
  let backlogChars = 0;
  let backlogItems = 0;
  let totalChars = 0;
  let totalItems = 0;
  let dropped = 0;
  let ended = false;
  return (event) =>
    Effect.suspend(() => {
      if (ended) return Effect.void;
      let recovered: Effect.Effect<void> = Effect.void;
      if (Queue.sizeUnsafe(queue) === 0) {
        backlogChars = backlogItems = totalChars = totalItems = 0;
        if (dropped > 0) {
          recovered = Effect.logInfo("terminal events subscriber caught up", {
            droppedOutputEvents: dropped,
          });
          dropped = 0;
        }
      }
      // Avoid serializing hot-path output; account for its metadata conservatively.
      const size =
        event.type === "output"
          ? event.data.length +
            event.threadId.length +
            event.terminalId.length +
            event.createdAt.length +
            128
          : JSON.stringify(event).length;
      const overTotal =
        totalItems >= (limits.totalItems ?? TERMINAL_EVENTS_OUTPUT_BACKLOG_LIMITS.totalItems) ||
        totalChars + size > (limits.totalChars ?? TERMINAL_EVENTS_OUTPUT_BACKLOG_LIMITS.totalChars);
      if (
        event.type === "output" &&
        (overTotal ||
          (backlogItems > 0 &&
            (backlogItems >= limits.items || backlogChars + event.data.length > limits.chars)))
      ) {
        dropped++;
        return dropped === 1
          ? Effect.andThen(
              recovered,
              Effect.logWarning("terminal events subscriber is behind; dropping output", {
                threadId: event.threadId,
                terminalId: event.terminalId,
                backlogChars,
                backlogItems,
              }),
            )
          : recovered;
      }
      if (overTotal) {
        ended = true;
        return Effect.gen(function* () {
          yield* Queue.clear(queue);
          Queue.endUnsafe(queue);
          yield* Effect.logWarning(
            "terminal events subscriber overflowed; resubscription required",
            {
              totalChars,
              totalItems,
            },
          );
        });
      }
      if (event.type === "output") {
        backlogChars += event.data.length;
        backlogItems++;
      }
      totalChars += size;
      totalItems++;
      return Effect.andThen(recovered, Queue.offer(queue, event)).pipe(Effect.asVoid);
    });
}
