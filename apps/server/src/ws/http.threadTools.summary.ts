import { MessageId, type ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type { ThreadOrchestrationToolDispatcherShape } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { ThreadToolRequestError, type ThreadToolRequest } from "./http.threadTools.schema.ts";

export const handleSetElevatorSummaryAction = Effect.fn("handleSetElevatorSummaryAction")(
  function* (input: {
    readonly dispatcher: ThreadOrchestrationToolDispatcherShape;
    readonly callerThreadId: ThreadId;
    readonly body: typeof ThreadToolRequest.Type;
  }) {
    const { body, dispatcher, callerThreadId } = input;
    if (body.threadId !== callerThreadId)
      return yield* new ThreadToolRequestError({
        status: body.threadId === undefined ? 400 : 401,
        message: "Current thread identity is required.",
      });
    if (
      body.targetThreadId !== undefined ||
      body.summary === undefined ||
      !body.invocationId?.trim() ||
      !body.sourceMessageId?.trim()
    )
      return yield* new ThreadToolRequestError({
        status: 400,
        message: "Only an own-thread summary with invocation identity is accepted.",
      });
    if (!dispatcher.setElevatorSummary)
      return yield* new ThreadToolRequestError({
        status: 503,
        message: "Thread summary tools are not ready.",
      });
    const result = yield* dispatcher
      .setElevatorSummary({
        threadId: callerThreadId,
        summary: body.summary,
        invocationId: body.invocationId,
        sourceMessageId: MessageId.makeUnsafe(body.sourceMessageId),
      })
      .pipe(
        Effect.mapError(
          (error) => new ThreadToolRequestError({ status: 400, message: error.message }),
        ),
      );
    return yield* HttpServerResponse.json({ ok: true, ...result });
  },
);
