import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { canOptimisticallyQueuePrompt } from "./ChatView.sendTurn.admission.logic";
import type { Thread } from "../../../models/types";

const thread = {
  id: ThreadId.makeUnsafe("thread-1"),
  messages: [{ id: "message-1" }],
  modelSelection: { provider: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as unknown as Thread;

function input(overrides: Partial<Parameters<typeof canOptimisticallyQueuePrompt>[0]> = {}) {
  return {
    activeThread: thread,
    isLocalDraftThread: false,
    bootstrapSourceThreadId: null,
    replyTarget: null,
    composerImages: [],
    composerFiles: [],
    composerAnnotations: [],
    composerTerminalContexts: [],
    selectedModelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    shouldQueuePrompt: true,
    planFollowUp: false,
    ...overrides,
  };
}

describe("canOptimisticallyQueuePrompt", () => {
  it("only optimizes plain follow-ups with inherited execution settings", () => {
    expect(canOptimisticallyQueuePrompt(input())).toBe(true);
    expect(canOptimisticallyQueuePrompt(input({ isLocalDraftThread: true }))).toBe(false);
    expect(
      canOptimisticallyQueuePrompt(input({ activeThread: { ...thread, messages: [] } as Thread })),
    ).toBe(false);
    expect(
      canOptimisticallyQueuePrompt(
        input({ selectedModelSelection: { provider: "codex", model: "gpt-5-mini" } }),
      ),
    ).toBe(false);
    expect(canOptimisticallyQueuePrompt(input({ replyTarget: {} as never }))).toBe(false);
  });
});
