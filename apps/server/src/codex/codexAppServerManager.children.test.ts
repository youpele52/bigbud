import { TurnId, type ProviderEvent } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { handleServerNotification } from "./codexAppServerManager.handlers.notification.ts";
import { interruptChildTurns } from "./codexAppServerManager.turn.children.ts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";

const PARENT = "thread-parent";
const CHILD = "thread-child";

function makeContext() {
  return {
    session: {
      provider: "codex",
      status: "running",
      threadId: "bigbud-thread",
      sessionEpoch: 1,
      activeTurnId: TurnId.makeUnsafe("parent-turn"),
    },
    collabReceiverTurns: new Map(),
    collabChildTurns: new Map(),
  } as unknown as CodexSessionContext;
}

function notify(context: CodexSessionContext, method: string, params: unknown) {
  const emitted: ProviderEvent[] = [];
  const updateSession = vi.fn((target: CodexSessionContext, updates: object) => {
    Object.assign(target.session, updates);
  });
  handleServerNotification(context, { method, params } as never, {
    emitEvent: (event) => emitted.push(event),
    updateSession,
  });
  return { emitted, updateSession };
}

const spawnActivity = {
  threadId: PARENT,
  turnId: "parent-turn",
  item: { id: "item-1", type: "subAgentActivity", kind: "started", agentThreadId: CHILD },
};

describe("Codex child agent threads", () => {
  it("learns a child from subAgentActivity and tracks its turn beyond the parent turn", () => {
    const context = makeContext();
    notify(context, "item/started", spawnActivity);
    expect(context.collabChildTurns.get(CHILD)).toBeNull();

    const childStart = notify(context, "turn/started", {
      threadId: CHILD,
      turn: { id: "child-turn", status: "inProgress" },
    });
    expect(childStart.emitted).toEqual([]);
    expect(childStart.updateSession).not.toHaveBeenCalled();
    expect(context.collabChildTurns.get(CHILD)).toBe("child-turn");

    // The parent turn ends (for example interrupted); the child keeps running.
    notify(context, "turn/completed", {
      threadId: PARENT,
      turn: { id: "parent-turn", status: "interrupted" },
    });
    expect(context.session.activeTurnId).toBeUndefined();
    expect(context.collabChildTurns.get(CHILD)).toBe("child-turn");

    // The child's own lifecycle still never drives the parent session.
    const childEnd = notify(context, "turn/completed", {
      threadId: CHILD,
      turn: { id: "child-turn", status: "interrupted" },
    });
    expect(childEnd.updateSession).not.toHaveBeenCalled();
    expect(context.session.status).toBe("ready");
    expect(context.collabChildTurns.get(CHILD)).toBeNull();
  });

  it("still learns children listed by older spawn calls", () => {
    const context = makeContext();
    notify(context, "item/completed", {
      threadId: PARENT,
      turnId: "parent-turn",
      item: { id: "item-2", type: "collabAgentToolCall", receiverThreadIds: [CHILD, "other"] },
    });
    expect([...context.collabChildTurns.keys()]).toEqual([CHILD, "other"]);
  });
});

describe("interruptChildTurns", () => {
  it("interrupts each running listed child once and skips idle or unknown ones", async () => {
    const context = makeContext();
    context.collabChildTurns.set(CHILD, TurnId.makeUnsafe("child-turn"));
    context.collabChildTurns.set("idle-child", null);
    const sendRequest = vi.fn(async () => ({}));

    await interruptChildTurns(context, [CHILD, CHILD, "idle-child", "unknown"], {
      sendRequest,
    } as never);

    expect(sendRequest.mock.calls).toEqual([
      [context, "turn/interrupt", { threadId: CHILD, turnId: "child-turn" }],
    ]);
  });

  it("tries every child and reports failures afterwards", async () => {
    const context = makeContext();
    context.collabChildTurns.set("a", TurnId.makeUnsafe("turn-a"));
    context.collabChildTurns.set("b", TurnId.makeUnsafe("turn-b"));
    const sendRequest = vi.fn(async (_context: unknown, _method: string, params: unknown) => {
      if ((params as { threadId: string }).threadId === "a") throw new Error("gone");
      return {};
    });

    await expect(
      interruptChildTurns(context, ["a", "b"], { sendRequest } as never),
    ).rejects.toThrow("Failed to interrupt 1 of 2 Codex child agent turns.");
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });
});
