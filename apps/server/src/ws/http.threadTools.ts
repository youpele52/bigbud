import { Data, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Schema } from "effect";

import { ServerConfig } from "../startup/config.ts";
import {
  isThreadOrchestrationToolAuthorized,
  readThreadOrchestrationToolAuthByToken,
} from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { getThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { ThreadId } from "@bigbud/contracts";

const THREAD_TOOLS_PATH = "/api/internal/thread-tools";

const ThreadToolRequest = Schema.Struct({
  action: Schema.Literals(["rename", "archive"]),
  threadId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
});

class ThreadToolRequestError extends Data.TaggedError("ThreadToolRequestError")<{
  readonly status: number;
  readonly message: string;
}> {}

export const threadOrchestrationToolsRouteLayer = HttpRouter.add(
  "POST",
  THREAD_TOOLS_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const dispatcher = getThreadOrchestrationToolDispatcher();
    if (!dispatcher) {
      return yield* new ThreadToolRequestError({
        status: 503,
        message: "Thread orchestration tools are not ready.",
      });
    }

    const body = yield* request.json.pipe(
      Effect.flatMap((value) =>
        Schema.decodeEffect(ThreadToolRequest)(value as typeof ThreadToolRequest.Type),
      ),
      Effect.mapError(
        () =>
          new ThreadToolRequestError({
            status: 400,
            message: "Invalid thread tool request.",
          }),
      ),
    );

    const token = request.headers["x-bigbud-thread-tool-token"];
    if (!token) {
      return yield* new ThreadToolRequestError({
        status: 401,
        message: "Unauthorized thread tool request.",
      });
    }
    const authRecord = yield* Effect.tryPromise({
      try: () => readThreadOrchestrationToolAuthByToken({ stateDir: config.stateDir, token }),
      catch: () => null,
    });

    if (
      authRecord === null ||
      (body.threadId !== undefined && body.threadId !== authRecord.threadId) ||
      !isThreadOrchestrationToolAuthorized({
        record: authRecord,
        threadId: authRecord?.threadId ?? "",
        token,
      })
    ) {
      return yield* new ThreadToolRequestError({
        status: 401,
        message: "Unauthorized thread tool request.",
      });
    }
    const threadId = ThreadId.makeUnsafe(authRecord.threadId);

    if (body.action === "rename") {
      const title = body.title?.trim() ?? "";
      const result = yield* dispatcher.rename({ threadId, title }).pipe(
        Effect.mapError(
          (error) =>
            new ThreadToolRequestError({
              status: 400,
              message: error instanceof Error ? error.message : "Failed to rename thread.",
            }),
        ),
      );
      return yield* HttpServerResponse.json({ ok: true, title: result.title });
    }

    yield* dispatcher.archive({ threadId }).pipe(
      Effect.mapError(
        (error) =>
          new ThreadToolRequestError({
            status: 400,
            message: error instanceof Error ? error.message : "Failed to archive thread.",
          }),
      ),
    );
    return yield* HttpServerResponse.json({ ok: true, archived: true });
  }).pipe(
    Effect.catchTag("ThreadToolRequestError", (error) =>
      HttpServerResponse.json({ ok: false, message: error.message }, { status: error.status }),
    ),
    Effect.catch(() =>
      HttpServerResponse.json(
        { ok: false, message: "Thread tool request failed." },
        { status: 500 },
      ),
    ),
  ),
);
