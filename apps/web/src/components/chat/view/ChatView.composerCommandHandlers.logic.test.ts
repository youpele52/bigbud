import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    isComposerShellMode: false,
    interactionMode: "default",
    activePendingProgress: null,
    activePendingUserInput: null,
    isOpencodePendingUserInputMode: false,
    setComposerCursor: vi.fn(),
    setComposerTrigger: vi.fn(),
    setComposerHighlightedItemId: vi.fn(),
    setComposerShellMode: vi.fn(),
    setComposerDraftTerminalContexts: vi.fn(),
    threadId: "thread-1" as never,
    setPrompt: vi.fn(),
    setPendingUserInputAnswersByRequestId: vi.fn(),
    applyPromptReplacement,
    onProviderModelSelect: vi.fn(),
    handleInteractionModeChange: vi.fn(),
    toggleInteractionMode: vi.fn(),
    onOpenReadDialog: vi.fn(),
    onSend: vi.fn(),
    onChangeActivePendingUserInputCustomAnswer: vi.fn(),
    ...overrides,
  };
}

function renderUseComposerCommandHandlers(
  input: UseComposerCommandHandlersInput,
): ReturnType<typeof useComposerCommandHandlers> {
  let handlers: ReturnType<typeof useComposerCommandHandlers> | null = null;

  function TestComponent() {
    handlers = useComposerCommandHandlers(input);
    return null;
  }

  renderToStaticMarkup(React.createElement(TestComponent));

  if (!handlers) {
    throw new Error("Failed to initialize composer command handlers");
  }

  return handlers as ReturnType<typeof useComposerCommandHandlers>;
}

describe("useComposerCommandHandlers", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("inserts /compact for the first-class compact command", () => {
    const input = makeInput();
    const handlers = renderUseComposerCommandHandlers(input);

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
    const input = makeInput({ promptRef: { current: "/ag" }, composerCursor: 3 });
    const handlers = renderUseComposerCommandHandlers(input);

    handlers.onSelectComposerItem({
      id: "provider-slash:claudeAgent:review",
      type: "slash-command",
      command: "review",
      label: "/review",
      description: "Claude provider command",
    });

    expect(input.handleInteractionModeChange).not.toHaveBeenCalled();
    expect(input.applyPromptReplacement).toHaveBeenCalledWith(0, 3, "/review ", {
      expectedText: "/ag",
    });
  });

  it("opens the read dialog for the first-class /read command", () => {
    const input = makeInput({ promptRef: { current: "/re" }, composerCursor: 3 });
    const handlers = renderUseComposerCommandHandlers(input);

    handlers.onSelectComposerItem({
      id: "slash:read",
      type: "slash-command",
      command: "read",
      label: "/read",
      description: "Read a remote document or web page URL into the thread",
    });

    expect(input.applyPromptReplacement).toHaveBeenCalledWith(0, 3, "", {
      expectedText: "/re",
    });
    expect(input.onOpenReadDialog).toHaveBeenCalled();
  });

  it("updates the slash discovery prompt without refocusing the composer", () => {
    const input = makeInput({
      promptRef: { current: "Use /agents reviewer" },
      composerCursor: "Use /agents reviewer".length,
    });
    const handlers = renderUseComposerCommandHandlers(input);

    handlers.onChangeComposerDiscoverySearch("agents", "architect");

    expect(input.applyPromptReplacement).toHaveBeenCalledWith(
      4,
      "Use /agents reviewer".length,
      "/agents architect",
      {
        expectedText: "/agents reviewer",
        focusComposer: false,
      },
    );
  });

  it("updates the model discovery prompt without refocusing the composer", () => {
    const input = makeInput({
      promptRef: { current: "Use /model gpt" },
      composerCursor: "Use /model gpt".length,
    });
    const handlers = renderUseComposerCommandHandlers(input);

    handlers.onChangeComposerDiscoverySearch("model", "claude");

    expect(input.applyPromptReplacement).toHaveBeenCalledWith(
      4,
      "Use /model gpt".length,
      "/model claude",
      {
        expectedText: "/model gpt",
        focusComposer: false,
      },
    );
  });
});
