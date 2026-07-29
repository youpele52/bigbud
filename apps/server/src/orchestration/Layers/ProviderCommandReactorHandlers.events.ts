export type ProviderIntentEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.message-sent"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.deletion-requested"
      | "project.deletion-requested";
  }
>;

export const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

export const markTurnStartHandled = (cache: Cache.Cache<string, true>, key: string) =>
  Cache.getOption(cache, key).pipe(
    Effect.flatMap((cached) => Cache.set(cache, key, true).pipe(Effect.as(Option.isSome(cached)))),
  );
import { Cache, Effect, Option } from "effect";
