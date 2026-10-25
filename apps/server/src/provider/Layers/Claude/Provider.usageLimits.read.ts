import { Effect } from "effect";
import { withClaudeProbeRuntime } from "./Provider.probeRuntime.ts";
import { normalizeClaudeUsageLimits, makeClaudeUsageLimitsError } from "./Provider.usageLimits.ts";

/** Requests only SDK subscription quota, without model discovery or local transcript scanning. */
export const readClaudeSubscriptionUsage = Effect.fn("readClaudeSubscriptionUsage")(function* (
  binaryPath: string,
) {
  return yield* withClaudeProbeRuntime(binaryPath, async (runtime) =>
    normalizeClaudeUsageLimits(
      await runtime.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      }),
      new Date().toISOString(),
    ),
  ).pipe(
    Effect.timeout("8 seconds"),
    Effect.orElseSucceed(() => makeClaudeUsageLimitsError(new Date().toISOString())),
  );
});
