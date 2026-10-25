/**
 * Ingestion of `turn.prompt-suggestion` (Phase 7): normalizes the suggestion and projects it
 * onto the thread as a `prompt.suggestion` activity bound to its turn, only while that turn is
 * the latest settled one. Nothing here sends a prompt or touches recovery or the queue.
 *
 * @module ProviderRuntimeIngestion.promptSuggestion
 */
import type { OrchestrationThread, ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import { buildPromptSuggestionActivity } from "../promptSuggestion.logic.ts";
import { toTurnId } from "./ProviderRuntimeIngestion.helpers.ts";
import { providerCommandId } from "./ProviderRuntimeIngestion.processor.runtime.command.ts";
import type { RuntimeProcessorServices } from "./ProviderRuntimeIngestion.processor.ts";

type PromptSuggestionEvent = Extract<ProviderRuntimeEvent, { type: "turn.prompt-suggestion" }>;

export function makePromptSuggestionIngestion(input: {
  readonly orchestrationEngine: RuntimeProcessorServices["orchestrationEngine"];
  readonly serverSettingsService: RuntimeProcessorServices["serverSettingsService"];
}) {
  return Effect.fn("ingestPromptSuggestion")(function* (
    event: PromptSuggestionEvent,
    thread: OrchestrationThread,
  ) {
    const enabled = yield* input.serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.promptSuggestions),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!enabled) return;
    const activity = buildPromptSuggestionActivity({
      thread,
      turnId: toTurnId(event.turnId),
      raw: event.payload.suggestion,
      source: event.payload.source,
      provider: event.provider,
      eventId: event.eventId,
      createdAt: event.createdAt,
    });
    if (activity === null) {
      yield* Effect.logDebug("prompt suggestion dropped", {
        threadId: thread.id,
        turnId: event.turnId ?? null,
        source: event.payload.source,
      });
      return;
    }
    yield* input.orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(event, "thread-activity-append"),
        threadId: thread.id,
        activity,
        createdAt: activity.createdAt,
      })
      .pipe(Effect.asVoid);
  });
}
