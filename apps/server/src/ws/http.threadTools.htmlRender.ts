import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ThreadOrchestrationToolDispatcherShape } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { ThreadToolRequestError, type ThreadToolRequest } from "./http.threadTools.schema.ts";

/** The caller identity comes only from the authenticated bridge, never from HTML arguments. */
export const handleHtmlRenderAction = Effect.fn("handleHtmlRenderAction")(function* (input: {
  dispatcher: ThreadOrchestrationToolDispatcherShape;
  threadId: ThreadId;
  body: typeof ThreadToolRequest.Type;
}) {
  if (!input.dispatcher.renderHtml)
    return yield* new ThreadToolRequestError({
      status: 503,
      message: "HTML rendering is not ready.",
    });
  const result = yield* input.dispatcher
    .renderHtml({
      threadId: input.threadId,
      invocationId: input.body.invocationId ?? "",
      arguments: input.body.htmlArguments,
      ...(input.body.htmlExpectedTurnId !== undefined
        ? { expectedTurnId: input.body.htmlExpectedTurnId }
        : {}),
    })
    .pipe(
      Effect.mapError(
        (error) => new ThreadToolRequestError({ status: 400, message: error.message }),
      ),
    );
  return yield* HttpServerResponse.json({ ok: true, result });
});
