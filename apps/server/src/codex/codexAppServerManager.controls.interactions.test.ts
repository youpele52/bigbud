import { expect, it, vi } from "vitest";
import { handleServerRequest } from "./codexAppServerManager.handlers.ts";
import {
  codexReliabilityHarness,
  exactRewindInput,
} from "./codexAppServerManager.reliability.test.helpers.ts";
import { codexProviderControls } from "./codexAppServerManager.controls.ts";
import type { CodexDynamicToolCallResult } from "./codexAppServerManager.types.ts";

it.each([true, false])(
  "keeps maintenance fenced until the native tool response was delivered=%s",
  async (delivered) => {
    const test = codexReliabilityHarness();
    test.context.collabReceiverTurns = new Map();
    const handled = Promise.withResolvers<CodexDynamicToolCallResult>();
    const written = Promise.withResolvers<void>();
    test.context.dynamicToolCallHandler = () => handled.promise;
    const writeMessage = vi.fn(() => written.promise);
    handleServerRequest(
      test.context,
      { id: 1, method: "item/tool/call", params: { threadId: "native", tool: "tool" } },
      {
        emitEvent: vi.fn(),
        writeMessage,
        isCurrent: () => true,
      },
    );
    expect(test.context.pendingToolCalls).toBe(1);
    handled.resolve({ success: true, contentItems: [] });
    await vi.waitFor(() => expect(writeMessage).toHaveBeenCalledTimes(1));
    expect(test.context.pendingToolCalls).toBe(1);
    await expect(
      codexProviderControls(
        test.context,
        { threadId: exactRewindInput.threadId, sessionEpoch: 2, action: "compact" },
        test.ops,
        () => true,
      ),
    ).rejects.toThrow("pending");
    if (delivered) {
      written.resolve();
      await vi.waitFor(() => expect(test.context.pendingToolCalls).toBe(0));
    } else {
      written.reject(new Error("uncertain write"));
      await written.promise.catch(() => undefined);
      expect(test.context.pendingToolCalls).toBe(1);
    }
  },
);
