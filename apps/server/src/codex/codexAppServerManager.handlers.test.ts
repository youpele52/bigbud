import { describe, expect, it, vi } from "vitest";

import { handleServerRequest } from "./codexAppServerManager.handlers";
import type { CodexSessionContext } from "./codexAppServerManager.types";

describe("codexAppServerManager server requests", () => {
  it("forwards the native request ID and source message context to dynamic tools", async () => {
    const dynamicToolCallHandler = vi.fn().mockResolvedValue({
      contentItems: [{ type: "inputText", text: "ok" }],
      success: true,
    });
    const writeMessage = vi.fn();
    const context = {
      session: { threadId: "caller-thread" },
      dynamicToolCallHandler,
    } as unknown as CodexSessionContext;

    handleServerRequest(
      context,
      {
        id: "codex-request-1",
        method: "item/tool/call",
        params: {
          namespace: "bigbud_orchestration",
          tool: "create_thread",
          sourceMessageId: "source-message-1",
          arguments: { title: "Side chat", task: "Investigate" },
        },
      },
      { emitEvent: vi.fn(), writeMessage },
    );

    await vi.waitFor(() => expect(dynamicToolCallHandler).toHaveBeenCalledOnce());
    expect(dynamicToolCallHandler).toHaveBeenCalledWith({
      namespace: "bigbud_orchestration",
      tool: "create_thread",
      requestId: "codex-request-1",
      sourceMessageId: "source-message-1",
      arguments: { title: "Side chat", task: "Investigate" },
    });
    await vi.waitFor(() =>
      expect(writeMessage).toHaveBeenCalledWith(context, {
        id: "codex-request-1",
        result: { contentItems: [{ type: "inputText", text: "ok" }], success: true },
      }),
    );
  });
});
