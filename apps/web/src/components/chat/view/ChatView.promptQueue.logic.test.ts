import { describe, expect, it } from "vitest";

import {
  formatQueuedPromptText,
  MAX_QUEUED_PROMPTS,
  type QueuedPrompt,
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
