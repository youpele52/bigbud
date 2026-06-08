import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { createEmptyReadModel } from "./projectorReadModel.ts";
import { asEventId, asMessageId, asProjectId } from "./decider.test.helpers.ts";

describe("decider — turn start", () => {
  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("message-user-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    const turnStartEvent = events[1];
    expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
    expect(turnStartEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
    if (turnStartEvent?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(turnStartEvent.payload).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: asMessageId("message-user-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "approval-required",
    });
  });

  it("resolves reply metadata into the emitted user message event", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-reply"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-reply"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-reply"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-reply"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-reply"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const withThread = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create-reply"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-reply"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create-reply"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create-reply"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-reply"),
          projectId: asProjectId("project-reply"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withThread, {
        sequence: 3,
        eventId: asEventId("evt-message-parent"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-reply"),
        type: "thread.message-sent",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-message-parent"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-message-parent"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-reply"),
          messageId: asMessageId("message-parent"),
          role: "assistant",
          text: "Earlier answer",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-reply"),
          threadId: ThreadId.makeUnsafe("thread-reply"),
          message: {
            messageId: asMessageId("message-user-reply"),
            role: "user",
            text: "follow up",
            attachments: [],
            replyToMessageId: asMessageId("message-parent"),
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events[0]?.type).toBe("thread.message-sent");
    if (events[0]?.type !== "thread.message-sent") {
      return;
    }
    expect(events[0].payload.replyTo).toEqual({
      messageId: asMessageId("message-parent"),
      role: "assistant",
      createdAt: now,
      excerpt: "Earlier answer",
    });
  });

  it("rejects reply targets that do not exist on the thread", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-missing-reply"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-missing-reply"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-missing-reply"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-missing-reply"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-missing-reply"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create-missing-reply"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-missing-reply"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create-missing-reply"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create-missing-reply"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-missing-reply"),
          projectId: asProjectId("project-missing-reply"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    await expect(
      Effect.runPromiseExit(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-start-missing-reply"),
            threadId: ThreadId.makeUnsafe("thread-missing-reply"),
            message: {
              messageId: asMessageId("message-user-missing-reply"),
              role: "user",
              text: "follow up",
              attachments: [],
              replyToMessageId: asMessageId("message-does-not-exist"),
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).resolves.toMatchObject({
      _tag: "Failure",
    });
  });
});
