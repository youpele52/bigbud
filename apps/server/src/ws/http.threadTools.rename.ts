import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import type { ThreadOrchestrationToolDispatcherShape } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { ThreadToolRequestError, type ThreadToolRequest } from "./http.threadTools.schema.ts";

/** Keeps the token-bound caller distinct from an optional canonical rename target. */
export const handleRenameThreadAction = Effect.fn("handleRenameThreadAction")(function* (input: {
  readonly dispatcher: ThreadOrchestrationToolDispatcherShape;
  readonly callerThreadId: ThreadId;
  readonly body: typeof ThreadToolRequest.Type;
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
  const renameInput = yield* Effect.try({
    try: () => ({
      threadId: callerThreadId,
      title: body.title?.trim() ?? "",
      ...(body.targetThreadId !== undefined
        ? { targetThreadId: ThreadId.makeUnsafe(body.targetThreadId.trim()) }
        : {}),
      ...(body.invocationId !== undefined ? { invocationId: body.invocationId } : {}),
      ...(body.sourceMessageId !== undefined
        ? { sourceMessageId: MessageId.makeUnsafe(body.sourceMessageId) }
        : {}),
    }),
    catch: () =>
      new ThreadToolRequestError({
        status: 400,
        message: "Invalid rename identity or target thread ID.",
      }),
  });
  const result = yield* dispatcher.rename(renameInput).pipe(
    Effect.mapError(
      (error) =>
        new ThreadToolRequestError({
          status: 400,
          message: error instanceof Error ? error.message : "Failed to rename thread.",
        }),
    ),
  );
  return yield* HttpServerResponse.json({ ok: true, ...result });
});
