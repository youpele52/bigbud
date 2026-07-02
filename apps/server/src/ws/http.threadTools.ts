import { Data, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Schema } from "effect";
import { ComputerUseAction, ThreadId } from "@bigbud/contracts";

import { ServerConfig } from "../startup/config.ts";
import {
  isThreadOrchestrationToolAuthorized,
  readThreadOrchestrationToolAuthByToken,
} from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { getThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";

const THREAD_TOOLS_PATH = "/api/internal/thread-tools";
const decodeComputerUseAction = Schema.decodeUnknownSync(ComputerUseAction);

const ThreadToolRequest = Schema.Struct({
  action: Schema.Literals(["rename", "archive", "get_status", "computer_use"]),
  threadId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  computerUseAction: Schema.optional(Schema.Unknown),
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
      if (body.threadId === undefined || body.threadId !== authRecord.threadId) {
        return yield* new ThreadToolRequestError({
          status: body.threadId === undefined ? 400 : 401,
          message:
            body.threadId === undefined
              ? "Current thread ID is required."
              : "Unauthorized thread tool request.",
        });
      }
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

    if (body.action === "get_status") {
      const targetThreadId = body.threadId?.trim() ?? "";
      if (targetThreadId.length === 0) {
        return yield* new ThreadToolRequestError({
          status: 400,
          message: "Thread ID is required.",
        });
      }
      const status = yield* dispatcher
        .getStatus({
          callerThreadId: threadId,
          threadId: ThreadId.makeUnsafe(targetThreadId),
        })
        .pipe(
          Effect.mapError((error) => {
            const message =
              error instanceof Error ? error.message : "Failed to read thread status.";
            const statusCode = message.includes("not found") ? 404 : 400;
            return new ThreadToolRequestError({
              status: statusCode,
              message,
            });
          }),
        );
      return yield* HttpServerResponse.json({ ok: true, status });
    }

    if (body.action === "computer_use") {
      const computerUseAction = yield* Effect.try({
        try: () => decodeComputerUseAction(body.computerUseAction),
        catch: () =>
          new ThreadToolRequestError({
            status: 400,
            message: "Invalid computer-use action.",
          }),
      });
      const result = yield* dispatcher
        .computerUse({
          threadId,
          action: computerUseAction,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ThreadToolRequestError({
                status: 400,
                message: error instanceof Error ? error.message : "Computer-use action failed.",
              }),
          ),
        );
      return yield* HttpServerResponse.json({ ok: true, result });
    }

    if (body.threadId === undefined || body.threadId !== authRecord.threadId) {
      return yield* new ThreadToolRequestError({
        status: body.threadId === undefined ? 400 : 401,
        message:
          body.threadId === undefined
            ? "Current thread ID is required."
            : "Unauthorized thread tool request.",
      });
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
