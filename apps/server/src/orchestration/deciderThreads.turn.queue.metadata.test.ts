import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideThreadQueueCommand } from "./deciderThreads.turn.queue.ts";

const now = "2026-08-01T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread-queue-metadata");

function readModel(overrides: Partial<OrchestrationReadModel["threads"][number]> = {}) {
  return {
    snapshotSequence: 0,
    projects: [],
    updatedAt: now,
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Queue metadata",
        elevatorSummary: null,
        elevatorSummaryMessageCount: 0,
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        queuedPrompts: [],
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        pinnedAt: null,
        deletingAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        tasks: [],
        activities: [],
        checkpoints: [],
        session: null,
        watchingThreads: [],
        ...overrides,
      },
    ],
  } satisfies OrchestrationReadModel;
}

function submit() {
  return {
    type: "thread.message.submit" as const,
    commandId: CommandId.makeUnsafe("submit-metadata"),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe("message-metadata"),
      text: "follow up",
    },
    delivery: "auto" as const,
    createdAt: now,
  };
}

describe("thread queued prompt metadata", () => {
  it.each(["text", "runtime", "model", "attachment"])(
    "rejects conflicting %s under an already queued message ID",
    async (field) => {
      const command = submit();
      const duplicate = {
        id: command.message.messageId,
        text: command.message.text,
        createdAt: now,
      };
      await expect(
        Effect.runPromise(
          decideThreadQueueCommand({
            command: {
              ...command,
              ...(field === "runtime" ? { runtimeMode: "full-access" as const } : {}),
              ...(field === "model"
                ? { modelSelection: { provider: "codex" as const, model: "gpt-5.4" } }
                : {}),
              message: {
                ...command.message,
                ...(field === "text" ? { text: "changed" } : {}),
                ...(field === "attachment"
                  ? {
                      attachments: [
                        {
                          type: "image" as const,
                          id: "image",
                          name: "image.png",
                          mimeType: "image/png",
                          sizeBytes: 1,
                        },
                      ],
                    }
                  : {}),
              },
            },
            readModel: readModel({ queuedPrompts: [duplicate] }),
          }),
        ),
      ).rejects.toThrow("already queued");
    },
  );

  it("keeps semantically identical queued message replay idempotent", async () => {
    const command = submit();
    expect(
      await Effect.runPromise(
        decideThreadQueueCommand({
          command: { ...command, modelSelection: { model: "gpt-5.4", provider: "codex" } },
          readModel: readModel({
            queuedPrompts: [
              {
                id: command.message.messageId,
                text: command.message.text,
                createdAt: now,
                modelSelection: { provider: "codex", model: "gpt-5.4" },
              },
            ],
          }),
        }),
      ),
    ).toEqual([]);
  });
  it("does not consume an ambiguously steered prefix on a new auto submission", async () => {
    const prompt = { id: MessageId.makeUnsafe("reserved"), text: "reserved", createdAt: now };
    const event = await Effect.runPromise(
      decideThreadQueueCommand({
        command: submit(),
        readModel: readModel({
          queuedPrompts: [prompt],
          pendingTurnControlOperation: {
            operationId: CommandId.makeUnsafe("steer"),
            action: "steer",
            reservedPromptIds: [prompt.id],
            sessionEpoch: 0,
            expectedTurnId: null,
            strategy: "native-steer",
            state: "ambiguous",
            requestedAt: now,
            updatedAt: now,
          },
        }),
      }),
    );
    expect(event).toMatchObject({ type: "thread.prompt-queued" });
  });

  it("does not extend an outstanding interrupt flush prefix", async () => {
    const prompt = { id: MessageId.makeUnsafe("reserved"), text: "reserved", createdAt: now };
    const event = await Effect.runPromise(
      decideThreadQueueCommand({
        command: submit(),
        readModel: readModel({
          queuedPrompts: [prompt],
          pendingInterruptFlushIntent: {
            intentId: CommandId.makeUnsafe("interrupt"),
            queuedPromptIds: [prompt.id],
            requestedAt: now,
          },
        }),
      }),
    );
    expect(event).toMatchObject({ type: "thread.prompt-queued" });
  });

  it("does not mistake model property ordering for a model change", async () => {
    const event = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          ...submit(),
          delivery: "queue",
          modelSelection: { model: "gpt-5.4", provider: "codex" },
        },
        readModel: readModel(),
      }),
    );
    expect(event).toMatchObject({ type: "thread.prompt-queued" });
  });

  it("captures explicit settings even when they differ from mutable defaults", async () => {
    const settings = {
      modelSelection: { provider: "codex" as const, model: "another-model" },
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
    };
    const event = await Effect.runPromise(
      decideThreadQueueCommand({
        command: { ...submit(), delivery: "queue", ...settings },
        readModel: readModel(),
      }),
    );
    expect(event).toMatchObject({ type: "thread.prompt-queued", payload: { prompt: settings } });
  });

  it("flushes captured settings rather than changed defaults", async () => {
    const settings = {
      modelSelection: { provider: "codex" as const, model: "captured-model" },
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
    };
    const prompt = {
      id: MessageId.makeUnsafe("captured"),
      text: "captured",
      createdAt: now,
      ...settings,
    };
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          type: "thread.queued-prompt.flush",
          commandId: CommandId.makeUnsafe("flush"),
          threadId,
          messageIds: [prompt.id],
          messageId: MessageId.makeUnsafe("combined"),
          createdAt: now,
        },
        readModel: readModel({ queuedPrompts: [prompt] }),
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.turn-start-requested",
          payload: expect.objectContaining(settings),
        }),
      ]),
    );
  });

  it("auto flushes the compatible head without applying the newest submit's settings", async () => {
    const prompt = { id: MessageId.makeUnsafe("legacy"), text: "legacy", createdAt: now };
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: { ...submit(), runtimeMode: "full-access" },
        readModel: readModel({ queuedPrompts: [prompt] }),
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.queued-prompts-flushed",
          payload: { threadId, messageIds: [prompt.id] },
        }),
      ]),
    );
  });

  it("rejects explicit flush across incompatible settings", async () => {
    const prompts = [
      { id: MessageId.makeUnsafe("legacy"), text: "legacy", createdAt: now },
      {
        id: MessageId.makeUnsafe("explicit"),
        text: "explicit",
        createdAt: now,
        runtimeMode: "full-access" as const,
      },
    ];
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          type: "thread.queued-prompt.flush",
          commandId: CommandId.makeUnsafe("flush"),
          threadId,
          messageIds: prompts.map((p) => p.id),
          messageId: MessageId.makeUnsafe("combined"),
          createdAt: now,
        },
        readModel: readModel({ queuedPrompts: prompts }),
      }),
    );
    expect(events).toEqual([]);
  });

  it("preserves metadata when the server can start immediately", async () => {
    const command = submit();
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          ...command,
          message: {
            ...command.message,
            attachments: [
              {
                type: "image",
                id: "image-1",
                name: "reference.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          },
          modelSelection: { provider: "codex", model: "gpt-5.4" },
        },
        readModel: readModel(),
      }),
    );
    expect(Array.isArray(events) ? events.map((event) => event.type) : []).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const message = Array.isArray(events)
      ? events.find((event) => event.type === "thread.message-sent")
      : null;
    expect(message && "payload" in message ? message.payload : null).toMatchObject({
      attachments: [{ id: "image-1", name: "reference.png" }],
    });
  });

  it("rejects metadata that cannot be retained in the busy queue", async () => {
    const command = submit();
    await expect(
      Effect.runPromise(
        decideThreadQueueCommand({
          command: {
            ...command,
            message: {
              ...command.message,
              attachments: [
                {
                  type: "image",
                  id: "image-1",
                  name: "reference.png",
                  mimeType: "image/png",
                  sizeBytes: 1,
                },
              ],
            },
          },
          readModel: readModel({
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
          }),
        }),
      ),
    ).rejects.toThrow("Attachments cannot be queued");
  });
});
