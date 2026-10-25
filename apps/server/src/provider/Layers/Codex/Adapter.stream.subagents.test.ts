import {
  EventId,
  ThreadId,
  TurnId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { makeCodexSubagentTracker } from "./Adapter.stream.subagents.ts";

type TaskEvent = Extract<ProviderRuntimeEvent, { type: "task.updated" }>;
const threadId = ThreadId.makeUnsafe("thread-codex");
let sequence = 0;

/** Notifications as `codexAppServerManager` emits them; item shapes follow the
 * `codex app-server generate-ts` 0.162.1 `ThreadItem` union. */
function notification(method: string, params: Record<string, unknown>): ProviderEvent {
  sequence += 1;
  return {
    id: EventId.makeUnsafe(`evt-${sequence}`),
    kind: "notification",
    provider: "codex",
    threadId,
    sessionEpoch: 5,
    createdAt: `2026-10-16T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    method,
    turnId: TurnId.makeUnsafe("turn-parent"),
    payload: params,
  } as ProviderEvent;
}

const collab = (
  method: "item/started" | "item/completed",
  item: Record<string, unknown>,
  sender = "provider-parent",
) =>
  notification(method, {
    threadId: sender,
    turnId: "turn-parent",
    item: {
      type: "collabAgentToolCall",
      id: `call-${sequence}`,
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: sender,
      receiverThreadIds: ["child-1"],
      prompt: "Audit the auth module",
      model: "gpt-5-codex",
      reasoningEffort: "high",
      agentsStates: { "child-1": { status: "pendingInit", message: null } },
      ...item,
    },
  });

const tasks = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.filter((event): event is TaskEvent => event.type === "task.updated");

describe("Codex collab subagents", () => {
  it("creates one subagent per spawned receiver with prompt, model, effort and depth", () => {
    const tracker = makeCodexSubagentTracker();
    const [task] = tasks(tracker.map(collab("item/started", {})));
    expect(task?.turnId).toBe("turn-parent");
    expect(task?.payload).toMatchObject({
      taskId: "codex:thread-codex:5:child-1",
      kind: "providerSubagent",
      nativeId: "child-1",
      status: "inProgress",
      prompt: "Audit the auth module",
      model: "gpt-5-codex",
      effort: "high",
      depth: 1,
    });
  });

  it("maps agent states, messages and terminal reasons", () => {
    const tracker = makeCodexSubagentTracker();
    tracker.map(collab("item/started", {}));
    const [done] = tasks(
      tracker.map(
        collab("item/completed", {
          tool: "wait",
          status: "completed",
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: { "child-1": { status: "completed", message: "Found 2 issues" } },
        }),
      ),
    );
    expect(done?.payload).toMatchObject({
      status: "completed",
      resultSummary: "Found 2 issues",
      model: "gpt-5-codex",
      prompt: "Audit the auth module",
    });
    expect(done?.payload.endedAt).toBeDefined();
    const expectations = [
      ["errored", "failed", undefined],
      ["interrupted", "stopped", undefined],
      ["shutdown", "stopped", undefined],
      ["notFound", "stopped", "agent not found"],
      ["running", "inProgress", undefined],
    ] as const;
    for (const [state, status, reason] of expectations) {
      const [task] = tasks(
        tracker.map(
          collab("item/completed", {
            tool: "wait",
            agentsStates: { "child-1": { status: state, message: null } },
          }),
        ),
      );
      expect(task?.payload.status, state).toBe(status);
      if (reason) expect(task?.payload.terminalReason).toBe(reason);
    }
  });

  it("updates status, model and effort from subAgentActivity items", () => {
    const tracker = makeCodexSubagentTracker();
    tracker.map(collab("item/started", { model: null, reasoningEffort: null }));
    const activity = (kind: string) =>
      notification("item/completed", {
        threadId: "provider-parent",
        item: {
          type: "subAgentActivity",
          id: `activity-${kind}`,
          kind,
          agentThreadId: "child-1",
          agentPath: "explorer",
          model: "gpt-5-mini",
          reasoningEffort: "low",
        },
      });
    const [interacted] = tasks(tracker.map(activity("interacted")));
    expect(interacted?.payload).toMatchObject({
      status: "inProgress",
      model: "gpt-5-mini",
      effort: "low",
      activeLabel: "explorer",
    });
    expect(tasks(tracker.map(activity("interrupted")))[0]?.payload.status).toBe("stopped");
    expect(tasks(tracker.map(activity("completed")))[0]?.payload.status).toBe("completed");
  });

  it("records child tool items as steps and nests agents spawned by a subagent", () => {
    const tracker = makeCodexSubagentTracker();
    tracker.map(collab("item/started", {}));
    const command = (method: "item/started" | "item/completed", status: string) =>
      notification(method, {
        threadId: "child-1",
        item: { type: "commandExecution", id: "cmd-1", command: "bun run test", status },
      });
    const [running] = tasks(tracker.map(command("item/started", "inProgress")));
    expect(running?.payload).toMatchObject({
      lastToolName: "command",
      recentSteps: [{ id: "cmd-1", toolName: "command", label: "bun run test", status: "running" }],
    });
    const [failed] = tasks(tracker.map(command("item/completed", "failed")));
    expect(failed?.payload.recentSteps?.[0]?.status).toBe("failed");
    const [nested] = tasks(
      tracker.map(
        collab(
          "item/started",
          {
            receiverThreadIds: ["child-2"],
            agentsStates: { "child-2": { status: "running", message: null } },
          },
          "child-1",
        ),
      ),
    );
    expect(nested?.payload).toMatchObject({
      nativeId: "child-2",
      depth: 2,
      parentTaskId: "codex:thread-codex:5:child-1",
    });
  });

  it("ignores unknown threads, other items and older payloads without collab fields", () => {
    const tracker = makeCodexSubagentTracker();
    expect(
      tracker.map(
        notification("item/started", {
          threadId: "stranger",
          item: { type: "commandExecution", id: "cmd-x", command: "ls", status: "inProgress" },
        }),
      ),
    ).toEqual([]);
    expect(
      tracker.map(
        notification("item/completed", {
          threadId: "provider-parent",
          item: { type: "collabAgentToolCall", id: "legacy" },
        }),
      ),
    ).toEqual([]);
    expect(tracker.map(notification("turn/started", { threadId: "provider-parent" }))).toEqual([]);
  });
});
