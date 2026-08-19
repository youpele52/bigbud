import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { projectEvent } from "./projector.ts";
import { createEmptyReadModel } from "./projectorReadModel.ts";
import { makeEvent } from "./projector.test.helpers.ts";

describe("orchestration projector — messages", () => {
  it("marks assistant messages completed with non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );

    const message = afterComplete.threads[0]?.messages[0];
    expect(message?.id).toBe("assistant:msg-1");
    expect(message?.text).toBe("hello");
    expect(message?.streaming).toBe(false);
    expect(message?.updatedAt).toBe(completeAt);
  });

  it("replaces streaming assistant text when the payload requests replacement semantics", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const replaceAt = "2026-02-23T10:00:01.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "prefix",
            turnId: "turn-1",
            streaming: true,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterReplace = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: replaceAt,
          commandId: "cmd-replace",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "replacement",
            turnId: "turn-1",
            replace: true,
            streaming: true,
            createdAt: replaceAt,
            updatedAt: replaceAt,
          },
        }),
      ),
    );

    const message = afterReplace.threads[0]?.messages[0];
    expect(message?.text).toBe("replacement");
    expect(message?.streaming).toBe(true);
  });

  it("heals a legacy checking projection when matching assistant streaming resumes", async () => {
    const createdAt = "2026-02-23T11:00:00.000Z";
    const threadId = "thread-1" as never;
    const turnId = "turn-1" as never;
    const afterCreate = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId,
            projectId: "project-1",
            title: "demo",
            modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );
    const createdThread = afterCreate.threads[0]!;
    const model = {
      ...afterCreate,
      threads: [
        {
          ...createdThread,
          session: {
            threadId,
            status: "error" as const,
            providerName: "codex" as const,
            runtimeMode: "full-access" as const,
            activeTurnId: turnId,
            reason: "provider.checking",
            lastError: "Status cannot be confirmed",
            updatedAt: createdAt,
          },
        },
      ],
    };

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: "cmd-delta",
          payload: {
            threadId,
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "still working",
            turnId,
            streaming: true,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    expect(next.threads[0]?.session).toMatchObject({
      status: "running",
      activeTurnId: turnId,
      reason: null,
      lastError: null,
    });
  });
});
