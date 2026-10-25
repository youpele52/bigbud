import { CommandId, EventId, type MessageId, type ThreadId, type TurnId } from "@bigbud/contracts";
import { Effect } from "effect";
import { USER_TURN_BOUND } from "@bigbud/shared/internalTextGeneration";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

/** Bind only an actual submitted user message, never internal generation or a provider tool event. */
export const recordSubmittedUserTurn = (
  services: SessionOpServices,
  input: {
    threadId: ThreadId;
    requestMessageId?: MessageId;
    turnId: TurnId;
    createdAt: string;
    /** The provider was idle again when acceptance was recorded, so the turn already ended. */
    providerIdle: boolean;
  },
) =>
  Effect.gen(function* () {
    if (!input.requestMessageId) return;
    const thread = yield* services.resolveThread(input.threadId);
    if (
      !thread?.messages.some(
        (message) => message.id === input.requestMessageId && message.role === "user",
      )
    )
      return;
    const id = `text-generation-user-turn:${input.threadId}:${input.requestMessageId}:${input.turnId}`;
    yield* services.orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        threadId: input.threadId,
        commandId: CommandId.makeUnsafe(`server:${id}`),
        createdAt: input.createdAt,
        activity: {
          id: EventId.makeUnsafe(id),
          kind: USER_TURN_BOUND,
          tone: "info",
          summary: "User turn submitted",
          turnId: input.turnId,
          payload: { messageId: input.requestMessageId, providerIdle: input.providerIdle },
          createdAt: input.createdAt,
        },
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });
