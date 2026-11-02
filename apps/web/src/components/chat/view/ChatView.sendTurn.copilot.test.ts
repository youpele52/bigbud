import { describe, expect, it, vi } from "vitest";
import { sendChatTurn } from "./ChatView.sendTurn.actions.chat";
const mocks = vi.hoisted(() => ({ guard: vi.fn(async () => false), prepare: vi.fn() }));
vi.mock("../provider/copilotRuntime.guard", () => ({ ensureCopilotRuntimeForChat: mocks.guard }));
vi.mock("./ChatView.sendTurn.prepare", () => ({
  prepareComposerPrompt: mocks.prepare,
  notifyOmittedTerminalContexts: vi.fn(),
}));

describe("missing Copilot send guard", () => {
  it("returns before preparing/resetting the composer, creating a thread, or dispatching a turn", async () => {
    const resetComposerDraft = vi.fn();
    const onSend = vi.fn();
    const dispatchCommand = vi.fn();
    await sendChatTurn({
      api: { orchestration: { dispatchCommand } } as never,
      input: {
        activeThread: { id: "draft" },
        selectedModelSelection: { provider: "copilot", model: "auto" },
      } as never,
      onSend,
      resetComposerDraft,
      ensureRemoteExecutionTargetAccess: vi.fn(),
    });
    expect(mocks.guard).toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(resetComposerDraft).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});
