import { CommandId, MessageId, TurnId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decideThreadQueueCommand } from "./deciderThreads.turn.queue.ts";
import { model, now, prompt, thread, threadId, turnId } from "./QueuedPromptPolicy.test.helpers.ts";

const command = {
  type: "thread.queued-prompt.flush" as const,
  commandId: CommandId.makeUnsafe("release"),
  threadId,
  messageIds: [prompt("one").id, prompt("two").id],
  messageId: MessageId.makeUnsafe("combined"),
  userRelease: true,
  expectedTurnId: turnId,
  expectedSessionEpoch: 1,
  createdAt: now,
  promptVersions: ["one", "two"].map((id) => ({
    id: prompt(id).id,
    createdAt: now,
    alreadySent: false,
  })),
  releaseSettings: {
    modelSelection: { provider: "codex" as const, model: "new-model" },
    runtimeMode: "approval-required" as const,
    interactionMode: "plan" as const,
  },
};
const decide = (value = thread(), cmd = command) =>
  Effect.runPromise(decideThreadQueueCommand({ command: cmd, readModel: model(value) }));

describe("authoritative manual queue release", () => {
  it("interrupts only the observed turn and leaves active settings alone", async () => {
    const event = await decide();
    expect(event).toMatchObject({
      type: "thread.turn-interrupt-requested",
      payload: { turnId, pendingFlushIntent: { queuedPromptIds: command.messageIds } },
    });
  });
  it("rejects a different turn or epoch without changing the queue", async () => {
    const current = thread();
    await expect(
      decide({
        ...current,
        session: { ...current.session!, activeTurnId: TurnId.makeUnsafe("new-turn") },
      }),
    ).rejects.toThrow("active turn or session has changed");
    await expect(
      decide({ ...current, session: { ...current.session!, sessionEpoch: 2 } }),
    ).rejects.toThrow("active turn or session has changed");
  });
  it("refuses removed or reincarnated selections", async () => {
    await expect(decide(thread({ queuedPrompts: [prompt("two")] }))).rejects.toThrow(
      "selected queue has changed",
    );
    await expect(
      decide(thread({ queuedPrompts: [{ ...prompt("one"), alreadySent: true }, prompt("two")] })),
    ).rejects.toThrow("selected queue has changed");
  });
  it("starts safely after the observed turn finished and commits idle settings with it", async () => {
    const current = thread();
    const events = await decide({
      ...current,
      session: { ...current.session!, activeTurnId: null, status: "ready" },
      queueHold: true,
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thread.meta-updated" }),
        expect.objectContaining({ type: "thread.runtime-mode-set" }),
        expect.objectContaining({ type: "thread.interaction-mode-set" }),
        expect.objectContaining({
          type: "thread.turn-start-requested",
          payload: expect.objectContaining(command.releaseSettings),
        }),
      ]),
    );
  });
  it("retains queued explicit settings precedence and compatible FIFO", async () => {
    const current = thread();
    const events = await decide({
      ...current,
      session: { ...current.session!, activeTurnId: null, status: "ready" },
      queuedPrompts: [{ ...prompt("one"), runtimeMode: "full-access" }, prompt("two")],
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.queued-prompts-flushed",
          payload: { threadId, messageIds: [prompt("one").id] },
        }),
        expect.objectContaining({
          type: "thread.turn-start-requested",
          payload: expect.objectContaining({ runtimeMode: "full-access" }),
        }),
      ]),
    );
  });
});
