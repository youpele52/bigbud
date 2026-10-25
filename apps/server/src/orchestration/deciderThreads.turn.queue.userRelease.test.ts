import { CommandId, MessageId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideThreadQueueCommand } from "./deciderThreads.turn.queue.ts";
import { now, readModel, threadId } from "./deciderThreads.turn.queue.test.helpers.ts";

const held = { id: MessageId.makeUnsafe("held"), text: "held message", createdAt: now };
const flush = (userRelease?: boolean) => ({
  type: "thread.queued-prompt.flush" as const,
  commandId: CommandId.makeUnsafe(`flush-${String(userRelease)}`),
  threadId,
  messageIds: [held.id],
  messageId: MessageId.makeUnsafe("released"),
  ...(userRelease !== undefined ? { userRelease } : {}),
  createdAt: now,
});
const decide = (command: ReturnType<typeof flush>, overrides: object) =>
  Effect.runPromise(
    decideThreadQueueCommand({
      command,
      readModel: readModel({ queuedPrompts: [held], ...overrides }),
    }),
  ).then((events) => (Array.isArray(events) ? events : [events]));

describe("Send now releases a held queue (queueHold: the user sends)", () => {
  it("releases a held fork's message with the thread's current model, nothing pinned", async () => {
    const claude = { provider: "claudeAgent", model: "sonnet" } as const;
    const events = await decide(flush(true), { queueHold: true, modelSelection: claude });
    expect(events.map((event) => event.type)).toEqual([
      "thread.queued-prompts-flushed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const requested = events.find((event) => event.type === "thread.turn-start-requested");
    expect(
      (requested?.payload as { modelSelection?: unknown } | undefined)?.modelSelection,
    ).toBeUndefined();
  });

  it("releases a queue held by Stop the same way", async () => {
    const stopped = {
      queueHold: true,
      session: {
        threadId: ThreadId.makeUnsafe("thread-queue"),
        status: "stopped",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        sessionEpoch: 1,
        reason: null,
        lastError: null,
        updatedAt: now,
      },
    };
    const events = await decide(flush(true), stopped);
    expect(events[0]?.type).toBe("thread.queued-prompts-flushed");
  });

  it("without the user's release a held queue still never sends", async () => {
    expect(await decide(flush(), { queueHold: true })).toEqual([]);
  });

  it("keeps every other guard: a reservation or a non-idle thread still blocks", async () => {
    const reserved = {
      queueHold: true,
      pendingTurnControlOperation: {
        operationId: CommandId.makeUnsafe("control"),
        action: "steer",
        reservedPromptIds: [held.id],
        sessionEpoch: 0,
        expectedTurnId: null,
        strategy: "native-steer",
        state: "requested",
      },
    };
    expect(await decide(flush(true), reserved)).toEqual([]);
    const running = {
      queueHold: true,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: "turn-1",
        sessionEpoch: 1,
        reason: null,
        lastError: null,
        updatedAt: now,
      },
    };
    expect(await decide(flush(true), running)).toEqual([]);
  });
});
