import { describe, expect, it, vi } from "vitest";
import { TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { handleServerRequest } from "./codexAppServerManager.handlers.ts";
import { handleServerNotification } from "./codexAppServerManager.handlers.notification.ts";
import { respondToRequest } from "./codexAppServerManager.interactions.ts";
import type { CodexSessionContext, CodexWriteOptions } from "./codexAppServerManager.types.ts";
import { CodexRpcError } from "./codexAppServerManager.errors.ts";
import "./codexAppServerManager.test.respondToUserInput.ts";

function harness() {
  const context = {
    session: { threadId: "ui", sessionEpoch: 3 },
    stopping: false,
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map([["child", TurnId.makeUnsafe("parent-turn")]]),
    collabChildTurns: new Map(),
  } as unknown as CodexSessionContext;
  const emitEvent = vi.fn();
  const writeMessage = vi.fn(
    (
      _context: CodexSessionContext,
      _message: unknown,
      options?: CodexWriteOptions,
    ): void | Promise<void> => {
      options?.onDispatch();
    },
  );
  return { context, emitEvent, writeMessage };
}
const approval = (id: string | number) => ({
  id,
  method: "item/commandExecution/requestApproval",
  params: { threadId: "child", turnId: "native-child-turn", itemId: "item" },
});

describe("Codex native interaction identity", () => {
  it("does not let an old parent completion settle a newer active turn", () => {
    const { context, emitEvent } = harness();
    context.session = {
      ...context.session,
      activeTurnId: TurnId.makeUnsafe("newer"),
      resumeCursor: { threadId: "parent" },
    };
    const updateSession = vi.fn();
    handleServerNotification(
      context,
      {
        method: "turn/completed",
        params: { threadId: "parent", turn: { id: "old", status: "completed" } },
      },
      { emitEvent, updateSession },
    );
    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });
  it("keeps child-native coordinates separate from the parent UI turn and typed IDs", () => {
    const { context, ...callbacks } = harness();
    handleServerRequest(context, approval(1), callbacks);
    handleServerRequest(context, approval("1"), callbacks);
    const [numeric, string] = [...context.pendingApprovals.values()];
    expect(numeric).toMatchObject({
      nativeThreadId: "child",
      nativeTurnId: "native-child-turn",
      turnId: "parent-turn",
      epoch: 3,
      state: "pending",
      jsonRpcId: 1,
    });
    handleServerNotification(
      context,
      { method: "serverRequest/resolved", params: { threadId: "child", requestId: "1" } },
      { ...callbacks, updateSession: vi.fn() },
    );
    expect(context.pendingApprovals.has(numeric!.requestId)).toBe(true);
    expect(context.pendingApprovals.has(string!.requestId)).toBe(false);
    expect(callbacks.emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: string!.requestId, turnId: "parent-turn" }),
    );
  });

  it("waits for the response write, keeps unconfirmed state, and never resubmits", async () => {
    const { context, emitEvent, writeMessage } = harness();
    handleServerRequest(context, approval(1), { emitEvent, writeMessage });
    const pending = [...context.pendingApprovals.values()][0]!;
    let release!: () => void;
    writeMessage.mockImplementation((_context, _message, options) => {
      options?.onDispatch();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const ops = { emitEvent, writeMessage, sendRequest: vi.fn(), updateSession: vi.fn() };
    const result = respondToRequest(context, pending.requestId, "accept", ops);
    expect(pending.responding).toBe(true);
    expect(emitEvent).toHaveBeenCalledTimes(1);
    await expect(respondToRequest(context, pending.requestId, "accept", ops)).rejects.toThrow(
      "already submitted",
    );
    handleServerRequest(context, approval(1), { emitEvent, writeMessage });
    expect(context.pendingApprovals.size).toBe(1);
    release();
    await result;
    expect(pending.state).toBe("response-sent-unconfirmed");
    expect(emitEvent).toHaveBeenCalledTimes(2);
    expect(context.pendingApprovals.has(pending.requestId)).toBe(true);
    handleServerNotification(
      context,
      { method: "serverRequest/resolved", params: { threadId: "child", requestId: 1 } },
      { emitEvent, updateSession: vi.fn() },
    );
    expect(context.pendingApprovals.size).toBe(0);
    expect(emitEvent).toHaveBeenCalledTimes(2);
    expect(writeMessage).toHaveBeenCalledOnce();
  });

  it("does not publish successful resolution on a failed write", async () => {
    const { context, emitEvent, writeMessage } = harness();
    handleServerRequest(context, approval(1), { emitEvent, writeMessage });
    const pending = [...context.pendingApprovals.values()][0]!;
    writeMessage.mockRejectedValueOnce(new Error("disconnected"));
    await expect(
      respondToRequest(context, pending.requestId, "accept", {
        emitEvent,
        writeMessage,
        sendRequest: vi.fn(),
        updateSession: vi.fn(),
      }),
    ).rejects.toThrow("disconnected");
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(pending.state).toBe("response-sent-unconfirmed");
  });

  it("allows a manual retry only when the transport proved non-delivery", async () => {
    const { context, emitEvent, writeMessage } = harness();
    handleServerRequest(context, approval(1), { emitEvent, writeMessage });
    const pending = [...context.pendingApprovals.values()][0]!;
    writeMessage.mockRejectedValueOnce(
      new CodexRpcError("response", 3, "not-dispatched", "queue full"),
    );
    const ops = { emitEvent, writeMessage, sendRequest: vi.fn(), updateSession: vi.fn() };
    await expect(respondToRequest(context, pending.requestId, "accept", ops)).rejects.toThrow(
      "queue full",
    );
    expect(pending.state).toBe("pending");
    expect(pending.responding).toBe(false);
    await respondToRequest(context, pending.requestId, "accept", ops);
    expect(pending.state).toBe("response-sent-unconfirmed");
    expect(writeMessage).toHaveBeenCalledTimes(2);
  });

  it("correlates native resolution arriving before the write callback without closing UI twice", async () => {
    const { context, emitEvent, writeMessage } = harness();
    handleServerRequest(context, approval(1), { emitEvent, writeMessage });
    const pending = [...context.pendingApprovals.values()][0]!;
    let release!: () => void;
    writeMessage.mockImplementation((_context, _message, options) => {
      options?.onDispatch();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const result = respondToRequest(context, pending.requestId, "accept", {
      emitEvent,
      writeMessage,
      sendRequest: vi.fn(),
      updateSession: vi.fn(),
    });
    handleServerNotification(
      context,
      { method: "serverRequest/resolved", params: { threadId: "child", requestId: 1 } },
      { emitEvent, updateSession: vi.fn() },
    );
    release();
    await result;
    expect(context.pendingApprovals.size).toBe(0);
    expect(emitEvent).toHaveBeenCalledTimes(2);
  });

  it("denies unsupported permissions before emitting any actionable event", () => {
    const { context, emitEvent, writeMessage } = harness();
    handleServerRequest(
      context,
      { id: 7, method: "item/permissions/requestApproval", params: {} },
      { emitEvent, writeMessage },
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "notification", method: "session/unsupportedRequest" }),
    );
    expect(emitEvent.mock.calls.some(([event]) => event.kind === "request")).toBe(false);
    expect(writeMessage).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ error: expect.objectContaining({ code: -32601 }) }),
    );
  });

  it("fences late dynamic tool callbacks from a replaced context", async () => {
    const { context, emitEvent, writeMessage } = harness();
    let release!: (result: { contentItems: []; success: boolean }) => void;
    context.dynamicToolCallHandler = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    let current = true;
    handleServerRequest(
      context,
      { id: 8, method: "item/tool/call", params: { tool: "test" } },
      {
        emitEvent,
        writeMessage,
        isCurrent: () => current,
      },
    );
    current = false;
    release({ contentItems: [], success: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(writeMessage).not.toHaveBeenCalled();
  });
});
