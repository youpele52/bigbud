/**
 * Automatic fork fallback (plan D16): when bounded in-place recovery ends `session-dead`, the
 * thread continues in a server-side fork with the same provider. Deterministic ids make a
 * redelivered failure map to the same fork, and the decider makes the command idempotent.
 *
 * @module ProviderCommandReactorHandlers.fork
 */
import { createHash } from "node:crypto";

import {
  CommandId,
  type EventId,
  type MessageId,
  type OrchestrationThread,
  ThreadId,
} from "@bigbud/contracts";
import { automaticForkThreadIds, findLiveAutomaticFork } from "@bigbud/shared/threadFork";
import { Cause, Effect } from "effect";

import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import {
  ensureOrchestrationThreadState,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { isForkThreadPresent } from "../deciderThreads.fork.logic.ts";

/** Same source and failure always name the same fork thread (uuid-shaped). */
export function autoForkThreadId(sourceThreadId: ThreadId, failureEventId: EventId): ThreadId {
  const hex = createHash("sha256").update(`${sourceThreadId}\0${failureEventId}`).digest("hex");
  return ThreadId.makeUnsafe(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}

/**
 * An automatic fork that has not answered in a turn of its own must not fork again: its failure
 * would only repeat on the next fork (no fork chains). Copied messages carry `turnId: null`, so
 * only the fork's own replies have a turn id; this does not depend on clocks.
 */
export function isUnprovenAutomaticFork(thread: OrchestrationThread): boolean {
  if (thread.forkOrigin === undefined || thread.forkOrigin.reason === "manual") return false;
  return !thread.messages.some(
    (message) => message.role === "assistant" && message.turnId !== null,
  );
}

export function makeRequestAutomaticFork(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
}) {
  return (request: {
    readonly sourceThreadId: ThreadId;
    readonly failureEventId: EventId;
    readonly pendingMessageId: MessageId;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const source = yield* ensureOrchestrationThreadState(
        input.orchestrationEngine,
        request.sourceThreadId,
        "history",
      );
      if (!source || isUnprovenAutomaticFork(source)) return;
      // At most one automatic fork while the source stays dead (D20): later failed sends keep
      // that fork, and the user decides whether their message follows it. A deleted fork does not
      // count, so the source may fork once more.
      const present = new Set<string>();
      for (const forkThreadId of new Set(automaticForkThreadIds(source))) {
        const fork = yield* ensureOrchestrationThreadState(
          input.orchestrationEngine,
          ThreadId.makeUnsafe(forkThreadId),
          "operational",
        );
        if (isForkThreadPresent(fork)) present.add(forkThreadId);
      }
      const live = findLiveAutomaticFork(source, (forkThreadId) => present.has(forkThreadId));
      if (live !== null) {
        return yield* Effect.logInfo("source already continued in an automatic fork", {
          threadId: request.sourceThreadId,
          forkThreadId: live.forkThreadId,
        });
      }
      // An automatic fork keeps the provider, so an unavailable provider cannot continue either.
      const available = yield* input.providerService
        .getCapabilities(source.modelSelection.provider)
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!available) return;
      yield* input.orchestrationEngine.dispatch({
        type: "thread.fork",
        commandId: CommandId.makeUnsafe(`server:thread-fork:${request.failureEventId}`),
        sourceThreadId: request.sourceThreadId,
        threadId: autoForkThreadId(request.sourceThreadId, request.failureEventId),
        reason: "recovery-failed",
        failureEventId: request.failureEventId,
        pendingMessageId: request.pendingMessageId,
        createdAt: request.createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("automatic fork after failed session recovery was not created", {
          threadId: request.sourceThreadId,
          failureEventId: request.failureEventId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
}
