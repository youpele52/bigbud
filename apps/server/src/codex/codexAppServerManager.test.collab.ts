import { describe, expect, it, vi } from "vitest";

import { createCollabNotificationHarness } from "./codexAppServerManager.test.helpers";

vi.mock("./codexVersionCheck", () => ({
  assertSupportedCodexCliVersion: vi.fn(),
}));

describe("collab child conversation routing", () => {
  it("rewrites child notification turn ids onto the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "msg_child_1",
        delta: "working",
      },
    });

    expect(emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        turnId: "turn_parent",
        itemId: "msg_child_1",
      }),
    );
  });

  it("suppresses child lifecycle notifications so they cannot replace the parent turn", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();
    updateSession.mockClear();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1" },
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/completed",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1", status: "completed" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("rewrites child approval requests onto the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "call_child_1",
        command: "bun install",
      },
    });

    expect(Array.from(context.pendingApprovals.values())[0]).toEqual(
      expect.objectContaining({
        turnId: "turn_parent",
        itemId: "call_child_1",
      }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/commandExecution/requestApproval",
        turnId: "turn_parent",
        itemId: "call_child_1",
      }),
    );
  });

  it("suppresses child lifecycle notifications even when the thread id is only top-level", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();
    updateSession.mockClear();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });
});
