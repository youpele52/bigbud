/**
 * Claude native prompt suggestions (Phase 7). With `promptSuggestions: true` the SDK emits at
 * most one `prompt_suggestion` per turn, after `result`. It maps to `turn.prompt-suggestion`
 * for the turn that just completed; ingestion normalizes it and decides whether it attaches.
 * A suggestion after a failed or interrupted turn, or once a new turn has started, is dropped.
 *
 * @module ClaudeAdapter.stream.promptSuggestion
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { PROMPT_SUGGESTION_RAW_MAX_LENGTH } from "@bigbud/contracts/orchestration/orchestration.promptSuggestion";
import { Effect } from "effect";

import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import { asRecord } from "./Adapter.sdk.messages.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";

type RuntimeEventBase = Omit<ProviderRuntimeEvent, "type" | "payload" | "turnId">;

export function makeClaudePromptSuggestionHandler(deps: {
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
}) {
  return Effect.fn("handleClaudePromptSuggestion")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
    base: RuntimeEventBase,
  ) {
    const settled = context.lastSettledTurn;
    const suggestion = asRecord(message)?.suggestion;
    if (
      context.turnState !== undefined ||
      settled === undefined ||
      !settled.completed ||
      typeof suggestion !== "string" ||
      suggestion.length > PROMPT_SUGGESTION_RAW_MAX_LENGTH
    ) {
      return;
    }
    yield* deps.offerRuntimeEvent(context, {
      ...base,
      turnId: settled.turnId,
      type: "turn.prompt-suggestion",
      payload: { suggestion, source: "native" },
    } as ProviderRuntimeEvent);
  });
}
