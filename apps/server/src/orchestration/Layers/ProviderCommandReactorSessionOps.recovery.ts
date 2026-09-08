import type { ProviderKind, ProviderSession, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { getProviderCapabilities } from "../../provider/providerCapabilities.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { ProviderCapabilityContextState } from "./ProviderCommandReactorSessionOps.capabilityContext.ts";

const CONTEXT_LIMIT_PATTERN =
  /\b(context (?:length|limit|window)|maximum context|max(?:imum)? tokens?|prompt (?:is )?too long|token limit)\b/i;

const collectErrorText = (value: unknown, seen = new Set<unknown>()): string => {
  if (value === null || value === undefined || seen.has(value)) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  seen.add(value);
  const record = value as Record<string, unknown>;
  return ["message", "detail", "issue", "cause", "error"]
    .map((key) => collectErrorText(record[key], seen))
    .filter(Boolean)
    .join(" ");
};

export const isProviderContextLimitError = (error: unknown): boolean =>
  CONTEXT_LIMIT_PATTERN.test(collectErrorText(error));

const HIGH_WATER_MARKS: Partial<Record<ProviderKind, number>> = {
  claudeAgent: 0.9,
  codex: 0.92,
  kilocode: 0.9,
  pi: 0.9,
};

export const shouldManagedCapabilityContextRollover = (input: {
  readonly provider: ProviderKind;
  readonly tokenUsageSemantics: "current-context" | "cumulative-only" | "unavailable" | undefined;
  readonly activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
  }>;
}): boolean => {
  if (input.tokenUsageSemantics !== "current-context") return false;
  const highWaterMark = HIGH_WATER_MARKS[input.provider];
  if (highWaterMark === undefined) return false;
  const latest = input.activities.findLast(
    (activity) => activity.kind === "context-window.updated",
  );
  if (!latest || !latest.payload || typeof latest.payload !== "object") return false;
  const payload = latest.payload as Record<string, unknown>;
  const usedTokens = payload.usedTokens;
  const maxTokens = payload.maxTokens;
  return (
    typeof usedTokens === "number" &&
    typeof maxTokens === "number" &&
    maxTokens > 0 &&
    usedTokens / maxTokens >= highWaterMark
  );
};

export const rolloverProviderSessionAtHighWater = Effect.fn("rolloverProviderSessionAtHighWater")(
  function* (input: {
    readonly providerService: ProviderServiceShape;
    readonly states: Map<string, ProviderCapabilityContextState>;
    readonly threadId: ThreadId;
    readonly sessionEpoch?: number;
    readonly activeSession: ProviderSession | undefined;
    readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
  }) {
    if (!input.activeSession) return undefined;
    if (HIGH_WATER_MARKS[input.activeSession.provider] === undefined) {
      return input.activeSession;
    }
    const capabilities = getProviderCapabilities(input.activeSession.provider);
    if (
      !shouldManagedCapabilityContextRollover({
        provider: input.activeSession.provider,
        tokenUsageSemantics: capabilities.tokenUsageSemantics,
        activities: input.activities,
      })
    ) {
      return input.activeSession;
    }
    yield* Effect.logInfo("rolling over provider session near context high-water mark", {
      threadId: input.threadId,
      provider: input.activeSession.provider,
    });
    yield* input.providerService.stopSession({
      threadId: input.threadId,
      sessionEpoch: input.sessionEpoch ?? 0,
    });
    input.states.delete(input.threadId);
    return undefined;
  },
);

export const withOneShotContextLimitRecovery = <A, E, R>(input: {
  readonly threadId: ThreadId;
  readonly providerService: ProviderServiceShape;
  readonly states: Map<string, ProviderCapabilityContextState>;
  readonly attempt: () => Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | import("../../provider/Errors.ts").ProviderServiceError, R> =>
  input.attempt().pipe(
    Effect.catch((error) => {
      if (!isProviderContextLimitError(error)) return Effect.fail(error);
      return Effect.gen(function* () {
        yield* Effect.logWarning("recovering provider session after context-limit failure", {
          threadId: input.threadId,
        });
        yield* input.providerService.stopSession({ threadId: input.threadId });
        input.states.delete(input.threadId);
        return yield* input.attempt();
      });
    }),
  );
