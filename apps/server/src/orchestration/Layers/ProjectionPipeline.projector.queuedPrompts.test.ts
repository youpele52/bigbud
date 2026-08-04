import { MessageId, ProjectId, ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { makeEvent } from "../projector.test.helpers.ts";
import { makeThreadsProjector } from "./ProjectionPipeline.projector.threads.ts";

const threadId = ThreadId.makeUnsafe("thread-queue");
const now = "2026-08-01T00:00:00.000Z";
const baseThread: ProjectionThread = {
  threadId,
  projectId: ProjectId.makeUnsafe("project-1"),
  title: "Queue",
  purpose: "standard",
  elevatorSummary: "Queue",
  elevatorSummaryMessageCount: 0,
  providerRuntimeExecutionTargetId: "local",
  workspaceExecutionTargetId: "local",
  executionTargetId: "local",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurnId: null,
  queuedPrompts: [],
  createdAt: now,
  updatedAt: now,
  lastActivityAt: now,
  archivedAt: null,
  pinnedAt: null,
  deletingAt: null,
  deletedAt: null,
};

function repository() {
  let current = baseThread;
  return {
    getById: () => Effect.succeed(Option.some(current)),
    listByProjectId: () => Effect.succeed([current]),
    upsert: (thread: ProjectionThread) => Effect.sync(() => void (current = thread)),
    deleteById: () => Effect.void,
    touchActivity: ({ occurredAt }: { readonly occurredAt: string }) =>
      Effect.sync(() => void (current = { ...current, lastActivityAt: occurredAt })),
    get: () => current,
  };
}

function event(
  sequence: number,
  type: "thread.prompt-queued" | "thread.queued-prompt-removed" | "thread.queued-prompts-flushed",
  payload: OrchestrationEvent["payload"],
): OrchestrationEvent {
  return makeEvent({
    sequence,
    type,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: `command-${sequence}`,
    payload,
  }) as OrchestrationEvent;
}

describe("durable queued prompt projector", () => {
  it("queues idempotently, removes one, and flushes only the observed prefix", async () => {
    const store = repository();
    const projector = makeThreadsProjector({ projectionThreadRepository: store });
    const sideEffects = { prunedThreadRelativePaths: new Map() };
    for (const [index, id] of ["one", "two", "three"].entries()) {
      await Effect.runPromise(
        projector.apply(
          event(index + 1, "thread.prompt-queued", {
            threadId,
            prompt: { id: MessageId.makeUnsafe(id), text: id, createdAt: now },
          }),
          sideEffects,
        ),
      );
    }
    await Effect.runPromise(
      projector.apply(
        event(4, "thread.queued-prompt-removed", {
          threadId,
          messageId: MessageId.makeUnsafe("two"),
        }),
        sideEffects,
      ),
    );
    await Effect.runPromise(
      projector.apply(
        event(5, "thread.queued-prompts-flushed", {
          threadId,
          messageIds: [MessageId.makeUnsafe("one")],
        }),
        sideEffects,
      ),
    );
    expect(store.get().queuedPrompts.map((prompt) => prompt.id)).toEqual(["three"]);
  });
});
