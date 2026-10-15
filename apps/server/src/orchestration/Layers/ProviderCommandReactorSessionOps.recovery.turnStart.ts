import { EventId, type ProviderKind, type ThreadId } from "@bigbud/contracts";
import type { TurnStartFailureClass } from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";
import { Cause, Effect, Result } from "effect";

import type { ProviderServiceError } from "../../provider/Errors.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { ProviderCapabilityContextState } from "./ProviderCommandReactorSessionOps.capabilityContext.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
import { classifyTurnStartFailure } from "./ProviderTurnFailureClassification.ts";

/** How a recovery attempt must (re)establish the provider session before sending. */
export type TurnStartRecoveryAttempt =
  | { readonly mode: "revive"; readonly resumeCursor: unknown }
  | { readonly mode: "fresh" };

/**
 * Providers whose "fresh" session is not isolated from the dead one, so a transcript replay would
 * duplicate native history (gate G2a, plan D13). They stop after the revive step.
 */
export const FRESH_REPLAY_EXCLUDED_PROVIDERS: ReadonlySet<ProviderKind> = new Set(["opencodeV2"]);

export const PROVIDER_SESSION_RECOVERY_ACTIVITY_KIND = "provider.session.recovery";
type RecoveryStep = "revive" | "fresh-replay";
type RecoveryOutcome = "started" | "succeeded" | "failed";

const RECOVERY_SUMMARIES: Record<RecoveryStep, Record<RecoveryOutcome, string>> = {
  revive: {
    started: "Reconnecting to the provider session",
    succeeded: "Reconnected to the provider session",
    failed: "Could not reconnect to the provider session",
  },
  "fresh-replay": {
    started: "Starting a fresh provider session with the conversation transcript",
    succeeded: "Continued in a fresh provider session; earlier messages were replayed as text",
    failed: "Could not continue in a fresh provider session",
  },
};

/**
 * Runs a turn-start attempt with bounded recovery (plan D12). `context-limit` gets one retry in a
 * fresh session. `session-dead` gets at most one revive (resume the same provider session) and one
 * fresh session with transcript replay. Every other class fails unchanged. Never loops: at most
 * two extra attempts per call, and the reactor handles each turn-start request once.
 */
export const withTurnStartRecovery = <A, E, R>(input: {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly providerService: ProviderServiceShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly states: Map<string, ProviderCapabilityContextState>;
  readonly attempt: (recovery?: TurnStartRecoveryAttempt) => Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | ProviderServiceError, R> => {
  const { threadId, providerService } = input;

  const appendRecovery = (
    step: RecoveryStep,
    outcome: RecoveryOutcome,
    failureClass?: TurnStartFailureClass,
  ) => {
    const createdAt = new Date().toISOString();
    return input.orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("provider-session-recovery"),
        threadId,
        activity: {
          id: EventId.makeUnsafe(crypto.randomUUID()),
          tone: outcome === "failed" ? "error" : "info",
          kind: PROVIDER_SESSION_RECOVERY_ACTIVITY_KIND,
          summary: RECOVERY_SUMMARIES[step][outcome],
          payload: {
            step,
            outcome,
            provider: input.provider,
            ...(failureClass ? { failureClass } : {}),
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to record provider session recovery activity", {
            threadId,
            step,
            outcome,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  };

  // Stopping removes the dead binding so the next attempt starts a new runtime session.
  const discardDeadSession = Effect.suspend(() => providerService.stopSession({ threadId })).pipe(
    Effect.ignore,
    Effect.andThen(Effect.sync(() => void input.states.delete(threadId))),
  );

  const runStep = (step: RecoveryStep, recovery: TurnStartRecoveryAttempt) =>
    Effect.gen(function* () {
      yield* appendRecovery(step, "started");
      const result = yield* input.attempt(recovery).pipe(Effect.result);
      yield* Result.isSuccess(result)
        ? appendRecovery(step, "succeeded")
        : appendRecovery(step, "failed", classifyTurnStartFailure(result.failure));
      return result;
    });

  const recoverDeadSession = (error: E) =>
    Effect.gen(function* () {
      // Capture the resume cursor first: stopping the session drops its binding.
      const live = (yield* providerService.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      const resumeCursor = live?.resumeCursor ?? undefined;
      const recoveryMode = (yield* providerService
        .getCapabilities(input.provider)
        .pipe(Effect.orElseSucceed(() => undefined)))?.sessionRecovery;
      yield* Effect.logWarning("recovering provider session after session-dead turn start", {
        threadId,
        provider: input.provider,
        recoveryMode,
        hasResumeCursor: resumeCursor !== undefined,
      });
      yield* discardDeadSession;
      let failure = error;
      if (
        resumeCursor !== undefined &&
        recoveryMode !== "fresh-restart" &&
        recoveryMode !== "unsupported"
      ) {
        const revived = yield* runStep("revive", { mode: "revive", resumeCursor });
        if (Result.isSuccess(revived)) return revived.success;
        failure = revived.failure;
        const reviveClass = classifyTurnStartFailure(failure);
        if (reviveClass !== "session-dead" && reviveClass !== "unknown") {
          return yield* Effect.fail(failure);
        }
        yield* discardDeadSession;
      }
      if (FRESH_REPLAY_EXCLUDED_PROVIDERS.has(input.provider)) return yield* Effect.fail(failure);
      const fresh = yield* runStep("fresh-replay", { mode: "fresh" });
      if (Result.isSuccess(fresh)) return fresh.success;
      return yield* Effect.fail(fresh.failure);
    });

  return input.attempt().pipe(
    Effect.catch((error) => {
      const failureClass = classifyTurnStartFailure(error);
      if (failureClass === "session-dead") return recoverDeadSession(error);
      if (failureClass !== "context-limit") return Effect.fail(error);
      return Effect.gen(function* () {
        yield* Effect.logWarning("recovering provider session after context-limit failure", {
          threadId,
        });
        yield* providerService.stopSession({ threadId });
        input.states.delete(threadId);
        return yield* input.attempt();
      });
    }),
  );
};
