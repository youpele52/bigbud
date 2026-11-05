import { Writable } from "node:stream";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerManager } from "./codexAppServerManager.ts";
import { handleServerRequest } from "./codexAppServerManager.handlers.ts";
import { handleServerNotification } from "./codexAppServerManager.handlers.notification.ts";
import { closeCodexTransport, writeCodexMessage } from "./codexAppServerManager.transport.ts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";

const contexts: CodexSessionContext[] = [];
function harness() {
  const writes: string[] = [];
  const callbacks: (() => void)[] = [];
  const stdin = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callbacks.push(callback);
    },
  });
  const threadId = ThreadId.makeUnsafe("ui");
  const context = {
    session: { threadId, sessionEpoch: 3, status: "ready" },
    child: { stdin },
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    collabChildTurns: new Map(),
    stopping: false,
  } as unknown as CodexSessionContext;
  contexts.push(context);
  const manager = new CodexAppServerManager();
  (manager as unknown as { sessions: Map<ThreadId, CodexSessionContext> }).sessions.set(
    threadId,
    context,
  );
  const emitEvent = vi.fn();
  manager.on("event", emitEvent);
  const callbacksForRequests = { emitEvent, writeMessage: writeCodexMessage };
  const receive = (kind: "approval" | "user-input" = "approval") =>
    handleServerRequest(
      context,
      {
        id: 1,
        method:
          kind === "approval"
            ? "item/commandExecution/requestApproval"
            : "item/tool/requestUserInput",
        params: { threadId: "native", turnId: "turn", itemId: "item" },
      },
      callbacksForRequests,
    );
  const resolve = () =>
    handleServerNotification(
      context,
      {
        method: "serverRequest/resolved",
        params: { threadId: "native", requestId: 1 },
      },
      { emitEvent, updateSession: vi.fn() },
    );
  const blocked = writeCodexMessage(context, { method: "initialized" });
  return { manager, context, threadId, writes, callbacks, blocked, receive, resolve, emitEvent };
}

afterEach(() => {
  for (const context of contexts.splice(0)) closeCodexTransport(context, new Error("test cleanup"));
});

describe("Codex interaction response admission at actual stdin dispatch", () => {
  it.each(["approval", "user-input"] as const)(
    "does not write a %s resolved while queued behind backpressure",
    async (kind) => {
      const {
        manager,
        context,
        threadId,
        receive,
        resolve,
        writes,
        callbacks,
        blocked,
        emitEvent,
      } = harness();
      receive(kind);
      const requests = kind === "approval" ? context.pendingApprovals : context.pendingUserInputs;
      const pending = [...requests.values()][0]!;
      const response =
        kind === "approval"
          ? manager.respondToRequest(threadId, pending.requestId, "accept")
          : manager.respondToUserInput(threadId, pending.requestId, { choice: "yes" });
      expect(writes).toHaveLength(1);
      resolve();
      callbacks.shift()!();
      await blocked;
      await response;
      expect(writes).toHaveLength(1);
      expect(requests.size).toBe(0);
      expect(emitEvent).toHaveBeenCalledTimes(2); // opened + native resolution, never submitted UI.
      expect(pending.state).toBe("pending");
    },
  );

  it("does not send an old decision when the native and canonical request IDs have both been reused", async () => {
    const { manager, context, threadId, receive, resolve, writes, callbacks, blocked } = harness();
    receive();
    const pending = [...context.pendingApprovals.values()][0]!;
    const oldResponse = manager.respondToRequest(threadId, pending.requestId, "accept");
    resolve();
    receive(); // Native numeric ID 1 is reused in the same thread and epoch.
    const replacement = [...context.pendingApprovals.values()][0]!;
    context.pendingApprovals.delete(replacement.requestId);
    context.pendingApprovals.set(pending.requestId, {
      ...replacement,
      requestId: pending.requestId,
    });
    const newResponse = manager.respondToRequest(threadId, pending.requestId, "decline");
    callbacks.shift()!();
    await blocked;
    await oldResponse;
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(JSON.parse(writes[1]!)).toEqual({ id: 1, result: { decision: "decline" } });
    callbacks.shift()!();
    await newResponse;
    expect(writes).toHaveLength(2);
  });

  it.each(["epoch", "thread", "turn", "item", "typed-id", "cancel"] as const)(
    "rechecks %s admission immediately before dispatch, not only when the response is queued",
    async (change) => {
      const { manager, context, threadId, receive, writes, callbacks, blocked, emitEvent } =
        harness();
      receive();
      const pending = [...context.pendingApprovals.values()][0]!;
      const response = manager.respondToRequest(threadId, pending.requestId, "accept");
      if (change === "epoch") {
        context.session = { ...context.session, sessionEpoch: 4 };
        pending.epoch = 4;
      } else if (change === "thread") pending.nativeThreadId = "replacement";
      else if (change === "turn") pending.nativeTurnId = undefined;
      else if (change === "item") delete pending.itemId;
      else if (change === "typed-id") pending.jsonRpcId = "1";
      else context.pendingApprovals.delete(pending.requestId);
      callbacks.shift()!();
      await blocked;
      await response;
      expect(writes).toHaveLength(1);
      expect(emitEvent).toHaveBeenCalledOnce();
      expect(pending.state).toBe("pending");
    },
  );
});
