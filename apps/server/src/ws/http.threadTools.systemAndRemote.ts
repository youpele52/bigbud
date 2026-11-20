import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import type { ThreadId } from "@bigbud/contracts";
import type { ThreadOrchestrationToolDispatcherShape } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { ThreadToolRequestError, type ThreadToolRequest } from "./http.threadTools.schema.ts";

/** Desktop resource monitor actions; reads degrade to an explicit unavailable result. */
export const handleSystemResourceAction = Effect.fn("handleSystemResourceAction")(
  function* (input: {
    dispatcher: ThreadOrchestrationToolDispatcherShape;
    body: typeof ThreadToolRequest.Type;
  }) {
    const { dispatcher, body } = input;
    if (body.action === "configure_system_resource_rules") {
      if (!dispatcher.configureSystemResourceRules)
        return yield* new ThreadToolRequestError({
          status: 503,
          message: "monitor settings unavailable",
        });
      const result = yield* dispatcher
        .configureSystemResourceRules(body.resourceArguments)
        .pipe(
          Effect.mapError(
            (error) => new ThreadToolRequestError({ status: 409, message: error.message }),
          ),
        );
      return yield* HttpServerResponse.json({ ok: true, result });
    }
    const result = dispatcher.getSystemResources
      ? yield* dispatcher
          .getSystemResources(body.resourceArguments ?? {})
          .pipe(
            Effect.catch(() =>
              Effect.succeed({ available: false, reason: "desktop monitor unavailable" }),
            ),
          )
      : { available: false, reason: "desktop monitor unavailable" };
    return yield* HttpServerResponse.json({ ok: true, result });
  },
);

/** Phase 5 remote-agent tools; the bridge's per-thread credential was verified by the caller. */
export const handleRemoteAgentAction = Effect.fn("handleRemoteAgentAction")(function* (input: {
  dispatcher: ThreadOrchestrationToolDispatcherShape;
  body: typeof ThreadToolRequest.Type;
}) {
  const tool = input.body.remoteAgentTool;
  if (!tool || !input.dispatcher.remoteAgent)
    return yield* new ThreadToolRequestError({
      status: 503,
      message: "Remote agent tools are not ready.",
    });
  const result = yield* input.dispatcher
    .remoteAgent({ tool, arguments: input.body.remoteAgentArguments ?? {} })
    .pipe(
      Effect.mapError(
        (error) => new ThreadToolRequestError({ status: 400, message: error.message }),
      ),
    );
  return yield* HttpServerResponse.json({ ok: true, result });
});

/** P8 peer delegation tools; the invocation id keys delegate retries onto one dispatch. */
export const handlePeerAction = Effect.fn("handlePeerAction")(function* (input: {
  dispatcher: ThreadOrchestrationToolDispatcherShape;
  threadId: ThreadId;
  body: typeof ThreadToolRequest.Type;
}) {
  const tool = input.body.peerTool;
  if (!tool || !input.dispatcher.peer)
    return yield* new ThreadToolRequestError({
      status: 503,
      message: "Peer delegation tools are not ready.",
    });
  const result = yield* input.dispatcher
    .peer({
      callerThreadId: input.threadId,
      invocationId: input.body.invocationId?.trim() ?? "",
      tool,
      arguments: input.body.peerArguments ?? {},
    })
    .pipe(
      Effect.mapError(
        (error) => new ThreadToolRequestError({ status: 400, message: error.message }),
      ),
    );
  return yield* HttpServerResponse.json({ ok: true, result });
});
