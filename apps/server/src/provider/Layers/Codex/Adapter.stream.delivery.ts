import { randomUUID } from "node:crypto";
import { EventId, type ProviderEvent, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect, Queue } from "effect";
import type { CodexAppServerManager } from "../../../codex/codexAppServerManager.ts";
import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import { mapToRuntimeEvents } from "./Adapter.stream.handlers.ts";
import { makeCodexSubagentTracker } from "./Adapter.stream.subagents.ts";
import { createCodexEventInbox } from "./Adapter.stream.inbox.ts";

/** Logging, mapping, and publication share one ordered worker, including slow logger writes. */
export const registerCodexEventDelivery = Effect.fn("registerCodexEventDelivery")(function* (
  manager: CodexAppServerManager,
  runtimeEventQueue: Queue.Queue<ProviderRuntimeEvent>,
  nativeEventLogger: EventNdjsonLogger | undefined,
  onFailure: (cause: unknown) => void,
) {
  const services = yield* Effect.services<never>();
  const subagents = makeCodexSubagentTracker();
  const consume = Effect.fn("consumeCodexEvent")(function* (event: ProviderEvent) {
    if (nativeEventLogger) yield* nativeEventLogger.write(event, event.threadId);
    yield* Queue.offerAll(runtimeEventQueue, [
      ...mapToRuntimeEvents(event, event.threadId),
      ...subagents.map(event),
    ]);
  });
  const inbox = createCodexEventInbox({
    consume: (event) => consume(event).pipe(Effect.runPromiseWith(services)),
    overflow: (event, cause) => {
      onFailure(cause);
      manager.off("event", listener);
      const sessions = manager.listSessions();
      manager.stopAll();
      return () =>
        Effect.gen(function* () {
          for (const session of sessions) {
            const warning: ProviderEvent = {
              id: EventId.makeUnsafe(randomUUID()),
              kind: "notification",
              provider: "codex",
              threadId: session.threadId,
              sessionEpoch: session.sessionEpoch!,
              createdAt: new Date().toISOString(),
              method: "session/deliveryUncertain",
              message: `Codex event delivery stopped; native outcome is unknown. ${cause instanceof Error ? cause.message : String(cause)}`,
            };
            yield* Queue.offerAll(runtimeEventQueue, mapToRuntimeEvents(warning, session.threadId));
          }
          if (sessions.length === 0) {
            yield* Queue.offerAll(
              runtimeEventQueue,
              mapToRuntimeEvents(
                {
                  ...event,
                  kind: "notification",
                  method: "session/deliveryUncertain",
                  message: "Codex event delivery stopped; native outcome is unknown.",
                },
                event.threadId,
              ),
            );
          }
        }).pipe(Effect.runPromiseWith(services));
    },
  });
  const listener = (event: ProviderEvent) => inbox.offer(event);
  manager.on("event", listener);
  return () => {
    manager.off("event", listener);
    inbox.close();
  };
});
