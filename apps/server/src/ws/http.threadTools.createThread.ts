/**
 * `create_thread` over the internal thread-tools route. Split from `http.threadTools.ts` to keep
 * that router under the file length limit.
 */
import { MessageId, ProjectId, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import type { ThreadOrchestrationToolDispatcherShape } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { ThreadToolRequestError, type ThreadToolRequest } from "./http.threadTools.schema.ts";

export const handleCreateThreadAction = Effect.fn("handleCreateThreadAction")(function* (input: {
  readonly dispatcher: ThreadOrchestrationToolDispatcherShape;
  readonly callerThreadId: ThreadId;
  readonly body: typeof ThreadToolRequest.Type;
}) {
  const { dispatcher, body } = input;
  if (!dispatcher.createThread) {
    return yield* new ThreadToolRequestError({
      status: 503,
      message: "Thread creation is not ready.",
    });
  }
  if (body.workspacePath !== undefined) {
    return yield* new ThreadToolRequestError({
      status: 400,
      message: "workspacePath is not supported; use projectId.",
    });
  }
  const invocationId = body.invocationId?.trim() ?? "";
  const sourceMessageId = body.sourceMessageId?.trim() ?? "";
  if (invocationId.length === 0) {
    return yield* new ThreadToolRequestError({
      status: 400,
      message: "invocationId is required.",
    });
  }
  if (sourceMessageId.length === 0) {
    return yield* new ThreadToolRequestError({
      status: 400,
      message: "sourceMessageId is required.",
    });
  }
  const result = yield* dispatcher
    .createThread({
      callerThreadId: input.callerThreadId,
      sourceMessageId: MessageId.makeUnsafe(sourceMessageId),
      invocationId,
      title: body.title ?? "",
      task: body.task ?? "",
      ...(body.projectId?.trim() ? { projectId: ProjectId.makeUnsafe(body.projectId.trim()) } : {}),
      watchForCompletion: body.watchForCompletion === true,
      // Raw and validated server-side: an unusable request falls back, it never fails (Goal 11).
      ...(body.modelSelection !== undefined ? { modelSelection: body.modelSelection } : {}),
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new ThreadToolRequestError({
            status: error instanceof Error && error.message.includes("not found") ? 404 : 400,
            message: error instanceof Error ? error.message : "Failed to create thread.",
          }),
      ),
    );
  return yield* HttpServerResponse.json({ ok: true, result });
});
