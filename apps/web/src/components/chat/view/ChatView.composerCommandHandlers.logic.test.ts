import { describe, expect, it, vi } from "vitest";

import {
  useComposerCommandHandlers,
  type UseComposerCommandHandlersInput,
} from "./ChatView.composerCommandHandlers.logic";

function makeInput(
  overrides: Partial<UseComposerCommandHandlersInput> = {},
): UseComposerCommandHandlersInput {
  const applyPromptReplacement = vi.fn(() => true);

  return {
    composerMenuOpenRef: { current: false },
    composerMenuItemsRef: { current: [] },
    activeComposerMenuItemRef: { current: null },
    composerSelectLockRef: { current: false },
    composerEditorRef: { current: null },
    promptRef: { current: "/co" },
    composerCursor: 3,
    composerTerminalContexts: [],
    composerMenuItems: [],
    composerHighlightedItemId: null,
    interactionMode: "default",
    activePendingProgress: null,
    activePendingUserInput: null,
    isOpencodePendingUserInputMode: false,
    setComposerCursor: vi.fn(),
    setComposerTrigger: vi.fn(),
    setComposerHighlightedItemId: vi.fn(),
    setComposerDraftTerminalContexts: vi.fn(),
    threadId: "thread-1" as never,
    setPrompt: vi.fn(),
    setPendingUserInputAnswersByRequestId: vi.fn(),
    applyPromptReplacement,
    onProviderModelSelect: vi.fn(),
    handleInteractionModeChange: vi.fn(),
    toggleInteractionMode: vi.fn(),
    onSend: vi.fn(),
    onChangeActivePendingUserInputCustomAnswer: vi.fn(),
    ...overrides,
  };
}

describe("useComposerCommandHandlers", () => {
  it("inserts /compact for the first-class compact command", () => {
    const input = makeInput();
    const handlers = useComposerCommandHandlers(input);

    handlers.onSelectComposerItem({
      id: "slash:compact:opencode",
      type: "slash-command",
      command: "compact",
      label: "/compact",
      description: "Compact context now using opencode",
    });

    expect(input.applyPromptReplacement).toHaveBeenCalledWith(0, 3, "/compact ", {
      expectedText: "/co",
    });
  });

  it("inserts generic provider slash commands instead of toggling default mode", () => {
    const input = makeInput({ promptRef: { current: "/rev" }, composerCursor: 4 });
    const handlers = useComposerCommandHandlers(input);

    handlers.onSelectComposerItem({
      id: "provider-slash:claudeAgent:review",
      type: "slash-command",
      command: "review",
      label: "/review",
      description: "Claude provider command",
    });

    expect(input.handleInteractionModeChange).not.toHaveBeenCalled();
    expect(input.applyPromptReplacement).toHaveBeenCalledWith(0, 4, "/review ", {
      expectedText: "/rev",
    });
  });
});
