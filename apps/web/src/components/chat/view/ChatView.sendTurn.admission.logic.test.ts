import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  canQueueComposerPrompt,
  changedQueuedPromptSettings,
} from "./ChatView.sendTurn.admission.logic";
import type { Thread } from "../../../models/types";

const thread = {
  id: ThreadId.makeUnsafe("thread-1"),
  messages: [{ id: "message-1" }],
  modelSelection: { provider: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as unknown as Thread;

function input(overrides: Partial<Parameters<typeof canQueueComposerPrompt>[0]> = {}) {
  return {
    activeThread: thread,
    isServerThread: true,
    isLocalDraftThread: false,
    bootstrapSourceThreadId: null,
    isComposerShellMode: false,
    shouldQueuePrompt: true,
    planFollowUp: false,
    ...overrides,
  };
}

describe("canQueueComposerPrompt", () => {
  it("queues every composer send on a busy server thread", () => {
    expect(canQueueComposerPrompt(input())).toBe(true);
  });

  it("keeps non-queue paths for idle, draft, empty, plan, bootstrap, and shell sends", () => {
    expect(canQueueComposerPrompt(input({ shouldQueuePrompt: false }))).toBe(false);
    expect(canQueueComposerPrompt(input({ activeThread: undefined }))).toBe(false);
    expect(canQueueComposerPrompt(input({ isServerThread: false }))).toBe(false);
    expect(canQueueComposerPrompt(input({ isLocalDraftThread: true }))).toBe(false);
    expect(
      canQueueComposerPrompt(input({ activeThread: { ...thread, messages: [] } as Thread })),
    ).toBe(false);
    expect(canQueueComposerPrompt(input({ planFollowUp: true }))).toBe(false);
    expect(
      canQueueComposerPrompt(input({ bootstrapSourceThreadId: ThreadId.makeUnsafe("source") })),
    ).toBe(false);
    expect(canQueueComposerPrompt(input({ isComposerShellMode: true }))).toBe(false);
  });
});

describe("changedQueuedPromptSettings", () => {
  const unchanged = {
    selectedModelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
  };

  it("omits settings that match the thread so plain prompts stay steerable", () => {
    expect(
      changedQueuedPromptSettings(
        { ...unchanged, selectedModelSelection: { provider: "codex", model: "gpt-5" } },
        thread,
      ),
    ).toEqual({});
  });

  it("carries only the settings the user changed", () => {
    expect(
      changedQueuedPromptSettings(
        {
          ...unchanged,
          selectedModelSelection: { provider: "codex", model: "gpt-5-mini" },
          interactionMode: "plan",
        },
        thread,
      ),
    ).toEqual({
      modelSelection: { provider: "codex", model: "gpt-5-mini" },
      interactionMode: "plan",
    });
    expect(
      changedQueuedPromptSettings({ ...unchanged, runtimeMode: "approval-required" }, thread),
    ).toEqual({ runtimeMode: "approval-required" });
  });
});
