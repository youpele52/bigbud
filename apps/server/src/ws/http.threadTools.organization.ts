import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import type { ThreadOrchestrationToolDispatcherShape } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { ThreadToolRequestError, type ThreadToolRequest } from "./http.threadTools.schema.ts";

/**
 * `move` and `snooze`: the token-bound caller stays the caller; an explicit target travels as
 * `targetThreadId` and is authorized like rename.
 */
export const handleOrganizationThreadAction = Effect.fn("handleOrganizationThreadAction")(
  function* (input: {
    readonly dispatcher: ThreadOrchestrationToolDispatcherShape;
    readonly callerThreadId: ThreadId;
    readonly body: typeof ThreadToolRequest.Type & { readonly action: "move" | "snooze" };
  }) {
    const { dispatcher, callerThreadId, body } = input;
    if (body.threadId === undefined || body.threadId !== callerThreadId) {
      return yield* new ThreadToolRequestError({
        status: body.threadId === undefined ? 400 : 401,
        message:
          body.threadId === undefined
            ? "Current thread ID is required."
            : "Unauthorized thread tool request.",
      });
    }
    const handler = body.action === "move" ? dispatcher.move : dispatcher.snooze;
    if (!handler) {
      return yield* new ThreadToolRequestError({
        status: 503,
        message: "Thread organization is not ready.",
      });
    }
    const shared = {
      threadId: callerThreadId,
      ...(body.targetThreadId !== undefined
        ? { targetThreadId: ThreadId.makeUnsafe(body.targetThreadId.trim()) }
        : {}),
      ...(body.invocationId !== undefined ? { invocationId: body.invocationId } : {}),
    };
    const result = yield* (
      body.action === "move"
        ? dispatcher.move!({ ...shared, state: body.organizationState ?? "" })
        : dispatcher.snooze!({ ...shared, minutes: body.durationMinutes ?? Number.NaN })
    ).pipe(
      Effect.mapError((error) => {
        const message = error instanceof Error ? error.message : `Failed to ${body.action} thread.`;
        return new ThreadToolRequestError({
          status: message.includes("not found") ? 404 : 400,
          message,
        });
      }),
    );
    return yield* HttpServerResponse.json({ ok: true, result });
  },
);
