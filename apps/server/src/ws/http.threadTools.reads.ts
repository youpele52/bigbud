/**
 * Read-only thread tool actions: thread status, pinned threads, and project
 * thread listings. Split from `http.threadTools.ts` to keep that router under
 * the file length limit.
 */
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import type { ThreadOrchestrationToolDispatcherShape } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { ThreadToolRequestError, type ThreadToolRequest } from "./http.threadTools.schema.ts";

type ThreadToolRequestBody = typeof ThreadToolRequest.Type;

interface ReadActionInput {
  readonly dispatcher: ThreadOrchestrationToolDispatcherShape;
  readonly callerThreadId: ThreadId;
  readonly body: ThreadToolRequestBody;
}

const toRequestError = (fallback: string) => (error: unknown) => {
  const message = error instanceof Error ? error.message : fallback;
  return new ThreadToolRequestError({
    status: message.includes("not found") ? 404 : 400,
    message,
  });
};

export const handleListPinnedThreadsAction = Effect.fn("handleListPinnedThreadsAction")(function* (
  input: ReadActionInput,
) {
  const result = yield* input.dispatcher
    .listPinned({ callerThreadId: input.callerThreadId })
    .pipe(Effect.mapError(toRequestError("Failed to list pinned threads.")));
  return yield* HttpServerResponse.json({ ok: true, result });
});

export const handleGetThreadStatusAction = Effect.fn("handleGetThreadStatusAction")(function* (
  input: ReadActionInput,
) {
  const targetThreadId = input.body.threadId?.trim() ?? "";
  if (targetThreadId.length === 0) {
    return yield* new ThreadToolRequestError({
      status: 400,
      message: "Thread ID is required.",
    });
  }
  const status = yield* input.dispatcher
    .getStatus({
      callerThreadId: input.callerThreadId,
      threadId: ThreadId.makeUnsafe(targetThreadId),
    })
    .pipe(Effect.mapError(toRequestError("Failed to read thread status.")));
  return yield* HttpServerResponse.json({ ok: true, status });
});

export const handleListThreadsAction = Effect.fn("handleListThreadsAction")(function* (
  input: ReadActionInput,
) {
  const listThreads = input.dispatcher.listThreads;
  if (!listThreads) {
    return yield* new ThreadToolRequestError({
      status: 503,
      message: "Thread listing is not ready.",
    });
  }
  const projectId = input.body.projectId?.trim() ?? "";
  const result = yield* listThreads({
    callerThreadId: input.callerThreadId,
    ...(projectId.length > 0 ? { projectId: ProjectId.makeUnsafe(projectId) } : {}),
    ...(input.body.status !== undefined ? { status: input.body.status } : {}),
    ...(input.body.limit !== undefined ? { limit: input.body.limit } : {}),
    includeExcerpt: input.body.includeExcerpt === true,
  }).pipe(Effect.mapError(toRequestError("Failed to list threads.")));
  return yield* HttpServerResponse.json({ ok: true, result });
});
