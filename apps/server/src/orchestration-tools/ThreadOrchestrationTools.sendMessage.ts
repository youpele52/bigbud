import { CommandId, MessageId, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import { requireThreadCoordinationAccess } from "./ThreadOrchestrationTools.access.ts";
import { stableThreadToolId } from "./ThreadOrchestrationTools.ts";

type SendThreadMessageOutcome =
  | { readonly delivery: "started" }
  | { readonly delivery: "queued"; readonly queuePosition: number };

function outcomeFromEvents(input: {
  readonly commandId: string;
  readonly events: ReadonlyArray<{
    readonly commandId: string | null;
    readonly type: string;
    readonly payload: unknown;
  }>;
}): SendThreadMessageOutcome | null {
  const events = input.events.filter((event) => event.commandId === input.commandId);
  if (events.some((event) => event.type === "thread.message-sent")) {
    return { delivery: "started" };
  }
  const queued = events.find((event) => event.type === "thread.prompt-queued");
  if (!queued || typeof queued.payload !== "object" || queued.payload === null) return null;
  const position = (queued.payload as { queuePosition?: unknown }).queuePosition;
  return typeof position === "number" ? { delivery: "queued", queuePosition: position } : null;
}

export const sendThreadMessageViaOrchestration = Effect.fn("sendThreadMessageViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
    readonly message: string;
    readonly delivery: "auto" | "queue";
    readonly invocationId: string;
  }) {
    const message = input.message.trim();
    if (message.length === 0 || message.length > 32_000) {
      return yield* Effect.fail(new Error("Message must be between 1 and 32000 characters."));
    }
    const readModel = yield* input.orchestrationEngine.getReadModel();
    const caller = readModel.threads.find((thread) => thread.id === input.callerThreadId);
    const target = readModel.threads.find((thread) => thread.id === input.threadId);
    if (!caller || caller.deletedAt !== null) {
      return yield* Effect.fail(new Error("Caller thread could not be resolved."));
    }
    if (!target || target.deletedAt !== null) {
      return yield* Effect.fail(new Error(`Thread '${input.threadId}' was not found.`));
    }
    yield* requireThreadCoordinationAccess({
      threadDelegationRepository: input.threadDelegationRepository,
      callerThread: caller,
      targetThread: target,
    });
    if (target.archivedAt !== null || target.deletingAt) {
      return yield* Effect.fail(new Error(`Thread '${input.threadId}' is not available.`));
    }
    const identity = `${input.callerThreadId}\n${input.threadId}\n${input.invocationId}`;
    const messageId = MessageId.makeUnsafe(stableThreadToolId("message", identity));
    const commandId = CommandId.makeUnsafe(stableThreadToolId("command", identity));
    const readEventsByCommandId = input.orchestrationEngine.readEventsByCommandId;
    if (!readEventsByCommandId) {
      return yield* Effect.fail(new Error("Command event lookup is not available."));
    }
    const committedOutcome = outcomeFromEvents({
      commandId,
      events: yield* readEventsByCommandId(commandId),
    });
    if (committedOutcome) return committedOutcome;
    yield* input.orchestrationEngine.dispatch({
      type: "thread.message.submit",
      commandId,
      threadId: target.id,
      message: { messageId, text: message },
      delivery: input.delivery,
      createdAt: new Date().toISOString(),
    });
    const events = yield* readEventsByCommandId(commandId);
    const outcome = outcomeFromEvents({ commandId, events });
    if (outcome) return outcome;
    return yield* Effect.fail(
      new Error(`Committed send command '${commandId}' did not produce a delivery outcome.`),
    );
  },
);
