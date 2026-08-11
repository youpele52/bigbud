import { CommandId, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { buildSendNowInterruptCommand } from "./ChatView.promptQueue.logic";

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
