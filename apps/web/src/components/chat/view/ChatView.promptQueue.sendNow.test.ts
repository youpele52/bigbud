import { CommandId, MessageId, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildSendNowFlushCommand,
  buildSendNowInterruptCommand,
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
