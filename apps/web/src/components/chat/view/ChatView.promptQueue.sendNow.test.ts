import { CommandId, MessageId, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildSendNowFlushCommand,
  buildSendNowInterruptCommand,
  sendNowQueuedPrompts,
} from "./ChatView.promptQueue.logic";

describe("Send now interrupt intent", () => {
  it("requests one durable settlement followed by queued-prefix flushing", () => {
    expect(
      buildSendNowInterruptCommand({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        commandId: CommandId.makeUnsafe("command-1"),
        queuedPromptIds: [],
        createdAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toEqual({
      type: "thread.turn.interrupt",
      commandId: "command-1",
      threadId: "thread-1",
      turnId: "turn-1",
      queuedPromptIdsAfterSettlement: [],
      createdAt: "2026-08-11T00:00:00.000Z",
    });
  });
});

describe("Send now on an idle thread", () => {
  it("is the user's release, so it also sends a held queue", () => {
    expect(
      buildSendNowFlushCommand({
        threadId: ThreadId.makeUnsafe("thread-1"),
        commandId: CommandId.makeUnsafe("command-1"),
        messageIds: [MessageId.makeUnsafe("held")],
        messageId: MessageId.makeUnsafe("combined"),
        createdAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toEqual({
      type: "thread.queued-prompt.flush",
      commandId: "command-1",
      threadId: "thread-1",
      messageIds: ["held"],
      messageId: "combined",
      userRelease: true,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
  });
});

describe("Send now persists the composer's settings before an idle release", () => {
  const ids = [MessageId.makeUnsafe("held")];
  const run = (overrides: Partial<Parameters<typeof sendNowQueuedPrompts>[0]>) => {
    const order: string[] = [];
    const calls = {
      interrupt: vi.fn(async () => void order.push("interrupt")),
      flush: vi.fn(async () => void order.push("flush")),
      onError: vi.fn(),
    };
    const done = sendNowQueuedPrompts({
      queuedPromptIds: ids,
      activeTurnInProgress: false,
      persistSettingsBeforeRelease: async () => {
        await Promise.resolve();
        order.push("persist");
      },
      ...calls,
      ...overrides,
    });
    return { done, order, calls };
  };

  it("awaits the persist before the release flush", async () => {
    const { done, order, calls } = run({});
    await done;
    expect(order).toEqual(["persist", "flush"]);
    expect(calls.flush).toHaveBeenCalledWith(ids);
  });

  it("never persists mid-turn: a runtime-mode change would restart the session under the interrupt", async () => {
    const { done, order } = run({ activeTurnInProgress: true });
    await done;
    expect(order).toEqual(["interrupt"]);
  });

  it("sends nothing and reports the error when persisting fails", async () => {
    const { done, calls } = run({
      persistSettingsBeforeRelease: () => Promise.reject(new Error("model update rejected")),
    });
    await done;
    expect(calls.flush).not.toHaveBeenCalled();
    expect(calls.interrupt).not.toHaveBeenCalled();
    expect(calls.onError).toHaveBeenCalledWith("model update rejected");
  });
});
