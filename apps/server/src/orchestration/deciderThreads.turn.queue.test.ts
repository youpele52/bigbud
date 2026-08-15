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
const threadId = ThreadId.makeUnsafe("thread-queue");

function readModel(overrides: Partial<OrchestrationReadModel["threads"][number]> = {}) {
  return {
    snapshotSequence: 0,
    projects: [],
    updatedAt: now,
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Queue",
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

const submit = (delivery: "auto" | "queue" = "auto") => ({
  type: "thread.message.submit" as const,
  commandId: CommandId.makeUnsafe(`submit-${delivery}`),
  threadId,
  message: { messageId: MessageId.makeUnsafe(`message-${delivery}`), text: " Follow up " },
  delivery,
  createdAt: now,
});

describe("thread queued prompt decider", () => {
  it("starts auto delivery immediately when the client thought busy but server is idle", async () => {
    const events = await Effect.runPromise(
      decideThreadQueueCommand({ command: submit(), readModel: readModel() }),
    );
    expect(Array.isArray(events) ? events.map((event) => event.type) : []).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });

  it("queues auto delivery while a provider turn is running", async () => {
    const model = readModel({
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    });
    const event = await Effect.runPromise(
      decideThreadQueueCommand({ command: submit(), readModel: model }),
    );
    expect(Array.isArray(event) ? null : (event as { readonly type: string }).type).toBe(
      "thread.prompt-queued",
    );
  });

  it.each([
    "provider.checking",
    "provider.recovering",
    "provider.stalled",
    "provider.lost-session",
  ])("queues auto delivery in health-unconfirmed state %s", async (reason) => {
    const event = await Effect.runPromise(
      decideThreadQueueCommand({
        command: submit(),
        readModel: readModel({
          session: {
            threadId,
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: "preserved-turn" as never,
            reason,
            lastError: "Status cannot be confirmed",
            updatedAt: now,
          },
        }),
      }),
    );
    expect(Array.isArray(event) ? null : (event as { readonly type: string }).type).toBe(
      "thread.prompt-queued",
    );
  });

  it.each(["approval.requested", "user-input.requested"] as const)(
    "queues auto delivery while %s is pending",
    async (kind) => {
      const event = await Effect.runPromise(
        decideThreadQueueCommand({
          command: submit(),
          readModel: readModel({
            activities: [
              {
                id: "pending" as never,
                kind,
                tone: kind === "approval.requested" ? "approval" : "info",
                summary: "Pending interaction",
                createdAt: now,
                turnId: null,
                payload:
                  kind === "approval.requested"
                    ? { requestId: "approval" }
                    : { requestId: "input", questions: [{}] },
              },
            ],
          }),
        }),
      );
      expect(Array.isArray(event) ? null : (event as { readonly type: string }).type).toBe(
        "thread.prompt-queued",
      );
    },
  );

  it("starts auto immediately after terminal state clears the active turn", async () => {
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: submit(),
        readModel: readModel({
          session: {
            threadId,
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            reason: null,
            lastError: "Previous turn failed",
            updatedAt: now,
          },
        }),
      }),
    );
    expect(Array.isArray(events) ? events.map((event) => event.type) : []).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });

  it("honors explicit queue delivery while idle", async () => {
    const event = await Effect.runPromise(
      decideThreadQueueCommand({ command: submit("queue"), readModel: readModel() }),
    );
    expect(Array.isArray(event) ? null : (event as { readonly type: string }).type).toBe(
      "thread.prompt-queued",
    );
  });

  it("atomically combines auto delivery with an existing idle queue", async () => {
    const queuedPrompts = [{ id: MessageId.makeUnsafe("one"), text: "one", createdAt: now }];
    const events = await Effect.runPromise(
      decideThreadQueueCommand({ command: submit(), readModel: readModel({ queuedPrompts }) }),
    );
    expect(Array.isArray(events) ? events.map((event) => event.type) : []).toEqual([
      "thread.prompt-queued",
      "thread.queued-prompts-flushed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });

  it("rejects a sixth queued prompt", async () => {
    const queuedPrompts = Array.from({ length: 5 }, (_, index) => ({
      id: MessageId.makeUnsafe(`queued-${index}`),
      text: `Prompt ${index}`,
      createdAt: now,
    }));
    await expect(
      Effect.runPromise(
        decideThreadQueueCommand({
          command: submit("queue"),
          readModel: readModel({ queuedPrompts }),
        }),
      ),
    ).rejects.toThrow("at most 5 prompts");
  });

  it("flushes only the exact observed prefix into one follow-up", async () => {
    const queuedPrompts = ["one", "two", "three"].map((text) => ({
      id: MessageId.makeUnsafe(text),
      text,
      createdAt: now,
    }));
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          type: "thread.queued-prompt.flush",
          commandId: CommandId.makeUnsafe("flush"),
          threadId,
          messageIds: queuedPrompts.slice(0, 2).map((prompt) => prompt.id),
          messageId: MessageId.makeUnsafe("combined"),
          createdAt: now,
        },
        readModel: readModel({ queuedPrompts }),
      }),
    );
    expect(Array.isArray(events) ? events.map((event) => event.type) : []).toEqual([
      "thread.queued-prompts-flushed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const message = Array.isArray(events)
      ? events.find((event) => event.type === "thread.message-sent")
      : undefined;
    expect(message?.payload.text).toContain("- one\n- two");
  });

  it("consumes only the durable Send now prefix and leaves later prompts queued", async () => {
    const queuedPrompts = ["one", "two", "three"].map((text) => ({
      id: MessageId.makeUnsafe(text),
      text,
      createdAt: now,
    }));
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          type: "thread.queued-prompt.flush",
          commandId: CommandId.makeUnsafe("flush-intent"),
          threadId,
          messageIds: queuedPrompts.slice(0, 2).map((prompt) => prompt.id),
          messageId: MessageId.makeUnsafe("combined"),
          createdAt: now,
        },
        readModel: readModel({
          queuedPrompts,
          pendingInterruptFlushIntent: {
            intentId: CommandId.makeUnsafe("send-now"),
            queuedPromptIds: queuedPrompts.slice(0, 2).map((prompt) => prompt.id),
            requestedAt: now,
          },
        }),
      }),
    );
    const flushed = Array.isArray(events)
      ? events.find((event) => event.type === "thread.queued-prompts-flushed")
      : undefined;
    expect(flushed?.payload.messageIds).toEqual(
      queuedPrompts.slice(0, 2).map((prompt) => prompt.id),
    );
  });

  it("does not flush a stale or running prefix", async () => {
    const queuedPrompts = [{ id: MessageId.makeUnsafe("one"), text: "one", createdAt: now }];
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          type: "thread.queued-prompt.flush",
          commandId: CommandId.makeUnsafe("flush-stale"),
          threadId,
          messageIds: [MessageId.makeUnsafe("different")],
          messageId: MessageId.makeUnsafe("combined"),
          createdAt: now,
        },
        readModel: readModel({ queuedPrompts }),
      }),
    );
    expect(events).toEqual([]);
  });

  it("does not flush when the observed prefix has shortened", async () => {
    const queuedPrompts = [{ id: MessageId.makeUnsafe("one"), text: "one", createdAt: now }];
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          type: "thread.queued-prompt.flush",
          commandId: CommandId.makeUnsafe("flush-shortened"),
          threadId,
          messageIds: [MessageId.makeUnsafe("one"), MessageId.makeUnsafe("removed")],
          messageId: MessageId.makeUnsafe("combined"),
          createdAt: now,
        },
        readModel: readModel({ queuedPrompts }),
      }),
    );
    expect(events).toEqual([]);
  });
});
