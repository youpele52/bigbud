import { CommandId, MessageId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildComposerFollowUpCommand,
  formatQueuedPromptText,
  MAX_QUEUED_PROMPTS,
  promptQueueErrorMessage,
  type QueuedPrompt,
  visibleQueuedPrompts,
} from "./ChatView.promptQueue.logic";

const queuedPrompt = (text: string, index: number): QueuedPrompt => ({
  id: `prompt-${index}`,
  text,
  createdAt: `2026-05-31T00:00:0${index}.000Z`,
});

describe("formatQueuedPromptText", () => {
  it("combines queued prompts into one structured follow-up", () => {
    expect(formatQueuedPromptText([queuedPrompt("First follow-up", 1), queuedPrompt("Second", 2)]))
      .toBe(`Additional instructions:

1. First follow-up

2. Second`);
  });

  it("trims queued prompt text", () => {
    expect(formatQueuedPromptText([queuedPrompt("  Keep this concise  ", 1)])).toContain(
      "1. Keep this concise",
    );
  });
});

describe("MAX_QUEUED_PROMPTS", () => {
  it("caps queued prompts at five", () => {
    expect(MAX_QUEUED_PROMPTS).toBe(5);
  });
});

describe("promptQueueErrorMessage", () => {
  it("uses command error messages and a stable fallback", () => {
    expect(promptQueueErrorMessage(new Error("Queue rejected"))).toBe("Queue rejected");
    expect(promptQueueErrorMessage("rejected")).toBe("Failed to update the prompt queue.");
  });
});

describe("buildComposerFollowUpCommand", () => {
  const base = {
    threadId: ThreadId.makeUnsafe("thread"),
    commandId: CommandId.makeUnsafe("command"),
    messageId: MessageId.makeUnsafe("message"),
    createdAt: "2026-08-13T00:00:00.000Z",
  };

  it("uses authoritative auto delivery for the routine text follow-up", () => {
    const command = buildComposerFollowUpCommand({
      ...base,
      submission: { text: "  Continue safely  " },
    });
    expect(command).toEqual({
      type: "thread.message.submit",
      commandId: base.commandId,
      threadId: base.threadId,
      message: { messageId: base.messageId, text: "Continue safely" },
      delivery: "auto",
      createdAt: base.createdAt,
    });
  });

  it("carries attachments, the reply target, and changed settings", () => {
    const attachment = {
      type: "image" as const,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AAA",
    };
    const command = buildComposerFollowUpCommand({
      ...base,
      submission: {
        text: "Look at this",
        attachments: [attachment],
        replyToMessageId: MessageId.makeUnsafe("earlier"),
        modelSelection: { provider: "codex", model: "gpt-5-mini" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
      },
    });
    expect(command).toMatchObject({
      message: {
        text: "Look at this",
        attachments: [attachment],
        replyToMessageId: "earlier",
      },
      modelSelection: { provider: "codex", model: "gpt-5-mini" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      delivery: "auto",
    });
  });
});

describe("visibleQueuedPrompts", () => {
  it("hides already-sent redeliveries that the timeline already shows", () => {
    const prompts = [
      { ...queuedPrompt("Redelivered", 1), alreadySent: true },
      queuedPrompt("Queued", 2),
    ];
    expect(visibleQueuedPrompts(prompts).map((prompt) => prompt.text)).toEqual(["Queued"]);
  });
});
