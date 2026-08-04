import type { ProviderSessionStartInput, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { resolveClaudeRuntimeTraits } from "./Adapter.session.options.ts";
import { toRequestError } from "./Adapter.utils.ts";

export const applyClaudeRuntimeTraits = Effect.fn("applyClaudeRuntimeTraits")(function* (input: {
  readonly context: ClaudeSessionContext;
  readonly modelSelection: ProviderSessionStartInput["modelSelection"];
  readonly threadId: ThreadId;
}) {
  const traits = resolveClaudeRuntimeTraits(input.modelSelection);
  const flagSettings: Parameters<ClaudeSessionContext["query"]["applyFlagSettings"]>[0] = {};
  if (input.context.currentEffort !== (traits.effectiveEffort ?? undefined)) {
    flagSettings.effortLevel = traits.effectiveEffort ?? null;
  }
  if (input.context.currentFastMode !== traits.fastMode) {
    flagSettings.fastMode = traits.fastMode;
  }
  if (input.context.currentThinking !== traits.thinking) {
    flagSettings.alwaysThinkingEnabled = traits.thinking ?? null;
  }
  if (input.context.currentUltracode !== traits.ultracode) {
    flagSettings.ultracode = traits.ultracode;
  }
  if (Object.keys(flagSettings).length === 0) return;

  yield* Effect.tryPromise({
    try: () => input.context.query.applyFlagSettings(flagSettings),
    catch: (cause) => toRequestError(input.threadId, "turn/applyFlagSettings", cause),
  });
  input.context.currentEffort = traits.effectiveEffort ?? undefined;
  input.context.currentFastMode = traits.fastMode;
  input.context.currentThinking = traits.thinking;
  input.context.currentUltracode = traits.ultracode;
});
