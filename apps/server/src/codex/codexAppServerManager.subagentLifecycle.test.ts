import { ThreadId, TurnId, type ProviderEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { mapToRuntimeEvents } from "../provider/Layers/Codex/Adapter.stream.handlers.ts";
import { makeCodexSubagentTracker } from "../provider/Layers/Codex/Adapter.stream.subagents.ts";
import { handleServerNotification } from "./codexAppServerManager.handlers.notification.ts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";

const PARENT = "provider-parent";
const CHILD = "provider-child";

function harness() {
  const context = {
    session: {
      provider: "codex",
      threadId: ThreadId.makeUnsafe("bigbud-thread"),
      sessionEpoch: 1,
      status: "running",
      activeTurnId: TurnId.makeUnsafe("parent-turn"),
      resumeCursor: { threadId: PARENT },
    },
    collabReceiverTurns: new Map(),
    collabChildTurns: new Map(),
  } as unknown as CodexSessionContext;
  const tracker = makeCodexSubagentTracker();
  function notify(method: string, params: unknown) {
    const emitted: ProviderEvent[] = [];
    handleServerNotification(
      context,
      { method, params },
      {
        emitEvent: (event) => emitted.push(event),
        updateSession: (target, updates) => Object.assign(target.session, updates),
      },
    );
    return emitted.flatMap((event) =>
      mapToRuntimeEvents(event, context.session.threadId).concat(tracker.map(event)),
    );
  }
  function activity(agentThreadId: string, agentPath: string, kind = "started") {
    return notify("item/completed", {
      threadId: PARENT,
      turnId: "parent-turn",
      item: {
        id: `activity-${agentThreadId}-${kind}`,
        type: "subAgentActivity",
        kind,
        agentThreadId,
        agentPath,
      },
    });
  }
  function turn(threadId: string, method: string, status: string, id = "child-turn") {
    return notify(method, {
      threadId,
      turn: { id, status, error: status === "failed" ? { message: "child failed" } : null },
    });
  }
  return { context, notify, activity, turn };
}

describe("Codex manager-to-adapter subagent lifecycle", () => {
  it("never classifies /root as a child or suppresses its parent completion", () => {
    const h = harness();
    const events = h.activity(PARENT, "/root");
    expect(events.filter((event) => event.type === "task.updated")).toEqual([]);
    expect(h.context.collabChildTurns.has(PARENT)).toBe(false);
    expect(h.context.collabReceiverTurns.has(PARENT)).toBe(false);

    const completed = h.turn(PARENT, "turn/completed", "completed", "parent-turn");
    expect(completed.map((event) => event.type)).toEqual(["turn.completed"]);
    expect(h.context.session.status).toBe("ready");
    expect(h.context.session.activeTurnId).toBeUndefined();
  });

  it("does not learn the session's native thread as a child even without a path", () => {
    const h = harness();
    expect(h.activity(PARENT, "").filter((event) => event.type === "task.updated")).toEqual([]);
    expect(h.context.collabChildTurns.has(PARENT)).toBe(false);
    expect(h.turn(PARENT, "turn/completed", "completed", "parent-turn")[0]?.type).toBe(
      "turn.completed",
    );
  });

  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["interrupted", "stopped"],
  ])("delivers child %s without changing the parent turn", (native, expected) => {
    const h = harness();
    h.activity(CHILD, "/root/worker");
    h.turn(CHILD, "turn/started", "inProgress");
    const events = h.turn(CHILD, "turn/completed", native);
    expect(events.map((event) => event.type)).toEqual(["task.updated"]);
    const done = events.find((event) => event.type === "task.updated");
    expect(done?.payload).toMatchObject({ nativeId: CHILD, status: expected });
    expect(done?.payload.endedAt).toBeDefined();
    if (native === "failed") expect(done?.payload.terminalReason).toBe("child failed");
    expect(done?.turnId).toBe("parent-turn");
    expect(h.context.session.status).toBe("running");
    expect(h.context.session.activeTurnId).toBe("parent-turn");
    expect(h.context.collabChildTurns.get(CHILD)).toBeNull();
  });

  it("delivers completion after the parent ended without resurrecting its turn", () => {
    const h = harness();
    h.activity(CHILD, "/root/worker");
    h.turn(CHILD, "turn/started", "inProgress");
    h.turn(PARENT, "turn/completed", "completed", "parent-turn");
    const events = h.turn(CHILD, "turn/completed", "completed");
    expect(events.map((event) => event.type)).toEqual(["task.updated"]);
    expect(events[0]?.turnId).toBe("parent-turn");
    expect(h.context.session.status).toBe("ready");
    expect(h.context.session.activeTurnId).toBeUndefined();
  });

  it("does not turn child thread state or unknown turn status into parent completion", () => {
    const h = harness();
    h.activity(CHILD, "/root/worker");
    expect(
      h.notify("thread/status/changed", { threadId: CHILD, status: { type: "idle" } }),
    ).toEqual([]);
    expect(h.turn(CHILD, "turn/completed", "unknown")).toEqual([]);
    expect(h.context.session.activeTurnId).toBe("parent-turn");
  });

  it("delivers a child abort without aborting the parent", () => {
    const h = harness();
    h.activity(CHILD, "/root/worker");
    h.turn(CHILD, "turn/started", "inProgress");
    const events = h.notify("turn/aborted", { threadId: CHILD, turnId: "child-turn" });
    expect(events.map((event) => event.type)).toEqual(["task.updated"]);
    const stopped = events.find((event) => event.type === "task.updated");
    expect(stopped?.payload.status).toBe("stopped");
    expect(h.context.collabChildTurns.get(CHILD)).toBeNull();
    expect(h.context.session.activeTurnId).toBe("parent-turn");
  });

  it("ignores a late completion for an older child turn", () => {
    const h = harness();
    h.activity(CHILD, "/root/worker");
    h.turn(CHILD, "turn/started", "inProgress", "first");
    h.turn(CHILD, "turn/started", "inProgress", "second");
    expect(h.turn(CHILD, "turn/completed", "completed", "first")).toEqual([]);
    expect(h.context.collabChildTurns.get(CHILD)).toBe("second");
    expect(h.turn(CHILD, "turn/completed", "completed", "second")[0]?.type).toBe("task.updated");
  });

  it("lets a real subsequent child turn resume a completed agent", () => {
    const h = harness();
    h.activity(CHILD, "/root/worker");
    h.turn(CHILD, "turn/started", "inProgress");
    h.turn(CHILD, "turn/completed", "completed");
    const events = h.turn(CHILD, "turn/started", "inProgress", "next-turn");
    const running = events.find((event) => event.type === "task.updated");
    expect(running?.payload.status).toBe("inProgress");
    expect(running?.payload.endedAt).toBeUndefined();
    expect(h.context.session.activeTurnId).toBe("parent-turn");
  });
});
