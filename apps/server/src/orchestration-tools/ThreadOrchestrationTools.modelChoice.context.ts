import { Effect, Option } from "effect";

import type { ThreadToolModelSources } from "./ThreadOrchestrationToolDispatcher.ts";
import type { ModelChoiceContext } from "./ThreadOrchestrationTools.modelChoice.usable.ts";

/** Enough recency for ranking; the query is deduplicated per provider+model+subProviderID. */
export const RECENT_MODEL_SELECTION_LIMIT = 200;

/**
 * Reads the cached inputs of a model decision. Never fails: missing sources, unreadable settings
 * or any defect yield `null` (reason `catalog-unavailable`, the trunk's model is used).
 */
export const loadModelChoiceContext = Effect.fn("loadModelChoiceContext")(function* (input: {
  readonly sources: ThreadToolModelSources | null | undefined;
  readonly target: ModelChoiceContext["target"];
}) {
  const sources = input.sources;
  if (!sources) return null;
  return yield* Effect.gen(function* () {
    const settings = yield* Effect.option(sources.getSettings);
    if (Option.isNone(settings)) return null;
    const providers = yield* sources.getProviders;
    const recent = yield* sources
      .listRecent(RECENT_MODEL_SELECTION_LIMIT)
      .pipe(Effect.orElseSucceed(() => []));
    return {
      providers,
      settings: settings.value,
      recent,
      target: input.target,
      hasInteractiveClient: sources.hasInteractiveClient(),
    } satisfies ModelChoiceContext;
  }).pipe(Effect.catchCause(() => Effect.succeed(null)));
});
