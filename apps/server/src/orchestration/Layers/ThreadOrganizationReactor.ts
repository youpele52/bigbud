import { CommandId } from "@bigbud/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { stableThreadToolId } from "../../orchestration-tools/ThreadOrchestrationTools.origins.ts";
import {
  ensureOrchestrationThreadState,
  OrchestrationEngineService,
} from "../Services/OrchestrationEngine.ts";
import {
  ThreadOrganizationReactor,
  type ThreadOrganizationReactorShape,
} from "../Services/ThreadOrganizationReactor.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { currentThreadOrganization } from "../threadOrganization.logic.ts";
import {
  isOrganizationReactionNeeded,
  organizationReactionForEvent,
} from "./ThreadOrganizationReactor.logic.ts";
import { startThreadSnoozeDelivery } from "./ThreadOrganizationReactor.snooze.ts";
import { startThreadIdleCleanup } from "./ThreadOrganizationReactor.idle.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";

const makeThreadOrganizationReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const threadRepository = yield* ProjectionThreadRepository;
  const settings = yield* ServerSettingsService;
  const terminalManager = yield* Effect.serviceOption(TerminalManager);

  const react = Effect.fn("reactToOrganizationEvent")(function* (
    event: Parameters<typeof organizationReactionForEvent>[0],
  ) {
    if (event.type === "thread.deleted" && Option.isSome(terminalManager)) {
      for (const threadId of new Set([event.aggregateId, ...(event.payload.threadIds ?? [])])) {
        yield* terminalManager.value.forgetThreadIdleWork?.(threadId) ?? Effect.void;
      }
    }
    const reaction = organizationReactionForEvent(event);
    if (!reaction) return;
    const thread = yield* ensureOrchestrationThreadState(
      orchestrationEngine,
      reaction.threadId,
      "operational",
    );
    if (!thread || thread.deletedAt !== null || thread.deletingAt || thread.archivedAt !== null) {
      return;
    }
    if (!isOrganizationReactionNeeded(currentThreadOrganization(thread), reaction)) return;
    // One command per causing fact: its receipt deduplicates replays of the same request.
    yield* orchestrationEngine
      .dispatch({
        type: "thread.organization.move",
        commandId: CommandId.makeUnsafe(
          stableThreadToolId("inyosira", JSON.stringify([reaction.threadId, reaction.key])),
        ),
        threadId: reaction.threadId,
        state: reaction.state,
        createdAt: event.occurredAt,
      })
      .pipe(Effect.catchTag("OrchestrationCommandIdConflictError", () => Effect.void));
  });

  const start: ThreadOrganizationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* startThreadSnoozeDelivery({ orchestrationEngine, threadRepository });
    yield* startThreadIdleCleanup({
      orchestrationEngine,
      threadRepository,
      settings,
      ...(Option.isSome(terminalManager) ? { terminalManager: terminalManager.value } : {}),
    });
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        react(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread organization reaction failed", {
              eventType: event.type,
              cause: cause.toString(),
            }),
          ),
        ),
      ),
    );
  });

  return { start } satisfies ThreadOrganizationReactorShape;
});

export const ThreadOrganizationReactorLive = Layer.effect(
  ThreadOrganizationReactor,
  makeThreadOrganizationReactor,
);
