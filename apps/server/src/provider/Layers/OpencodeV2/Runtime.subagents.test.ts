import type { SessionInfo } from "@opencode/client";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";

import { withV2RuntimeFixture, type V2RuntimeHttpFixture } from "./Runtime.fixture.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { v2SharedToolPolicy } from "./Runtime.policy.shared.ts";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

type TaskEvent = Extract<ProviderRuntimeEvent, { type: "task.updated" }>;
const taskEvents = (events: ProviderRuntimeEvent[]) =>
  events.filter((event): event is TaskEvent => event.type === "task.updated");

async function startRunning(
  runtime: OpencodeV2Runtime,
  http: V2RuntimeHttpFixture,
  directory: string,
  name: string,
  subagentCall = true,
) {
  const threadId = ThreadId.makeUnsafe(name);
  http.autoComplete = false;
  await runtime.start({ threadId, cwd: directory, modelSelection, runtimeMode: "full-access" });
  await runtime.send({
    threadId,
    modelSelection,
    requestMessageId: MessageId.makeUnsafe(`${name}-request`),
    input: "synthetic",
  });
  const session = runtime.get(threadId);
  http.messages.get(session.native.id)!.push({
    id: "msg_parent",
    type: "assistant",
    agent: "build",
    model: session.model,
    time: { created: 3 },
    content: subagentCall
      ? [
          {
            type: "tool",
            id: "tool_subagent",
            name: "subagent",
            time: { created: 3 },
            state: { status: "running", input: {}, metadata: {} },
          },
        ]
      : [],
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  return session;
}

function addChild(http: V2RuntimeHttpFixture, session: V2RuntimeSession, patch = {}) {
  const child: SessionInfo = {
    id: "ses_child",
    parentID: session.native.id,
    projectID: "synthetic",
    agent: "explore",
    title: "Index the docs folder",
    model: { providerID: "synthetic-provider", id: "synthetic-model", variant: "high" },
    cost: 0.002,
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 5, write: 0 } },
    time: { created: 1_000, updated: 2_000 },
    location: session.native.location,
    ...patch,
  };
  http.sessions.set(child.id, child);
  return child;
}

describe("OpenCode v2 read-only subagent observer", () => {
  it("maps an active child to a providerSubagent task without liveness evidence", async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      const session = await startRunning(runtime, http, directory, "observe-active");
      addChild(http, session);
      // A sibling fork and an unrelated session are never subagents.
      addChild(http, session, { id: "ses_fork", fork: { sessionID: "x", boundary: {} } });
      addChild(http, session, { id: "ses_other", parentID: "ses_unrelated" });
      vi.spyOn(http.client.session, "active").mockResolvedValue({
        ses_child: { type: "running" },
      });
      await runtime.reconcile(session);
      const [task] = taskEvents(events);
      expect(taskEvents(events)).toHaveLength(1);
      expect(task?.turnId).toBeUndefined();
      expect(task?.payload).toMatchObject({
        taskId: `opencodeV2:observe-active:${session.epoch}:ses_child`,
        kind: "providerSubagent",
        nativeId: "ses_child",
        status: "inProgress",
        activityFresh: true,
        subject: "explore",
        subagentType: "explore",
        description: "Index the docs folder",
        model: "synthetic-provider/synthetic-model",
        effort: "high",
        depth: 1,
        metrics: { totalTokens: 150, costUsd: 0.002 },
        source: "observed",
        turnId: session.row?.turnId,
        createdAt: new Date(1_000).toISOString(),
      });
      expect(task?.payload.endedAt).toBeUndefined();
      // Unchanged state emits nothing new.
      await runtime.reconcile(session);
      expect(taskEvents(events)).toHaveLength(1);
      // The child is only ever read through the parent-scoped listing; it is never mutated.
      expect(http.calls.filter((call) => call.pathname.includes("ses_child"))).toHaveLength(0);
      // The only session write is the parent's own creation.
      expect(
        http.calls.filter((call) => call.pathname === "/api/session" && call.method === "POST"),
      ).toHaveLength(1);
      expect(session.row?.state).toBe("accepted");
    });
  });

  it("maps outcomes to terminal states with end time and duration", async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      const session = await startRunning(runtime, http, directory, "observe-outcome");
      const active = vi
        .spyOn(http.client.session, "active")
        .mockResolvedValue({ ses_child: { type: "running" } });
      addChild(http, session);
      await runtime.reconcile(session);
      active.mockResolvedValue({});
      addChild(http, session, {
        outcome: "succeeded",
        time: { created: 1_000, updated: 4_000, idle: 3_500 },
      });
      await runtime.reconcile(session);
      const latest = taskEvents(events).at(-1)!;
      expect(latest.payload).toMatchObject({
        status: "completed",
        activityFresh: false,
        endedAt: new Date(3_500).toISOString(),
        metrics: { totalTokens: 150, costUsd: 0.002, durationMs: 2_500 },
      });
      expect(latest.payload.freshness.providerRevision).toBe(4_000);
      for (const [outcome, status] of [
        ["failed", "failed"],
        ["interrupted", "stopped"],
      ] as const) {
        addChild(http, session, { outcome, time: { created: 1_000, updated: 5_000 } });
        await runtime.reconcile(session);
        expect(taskEvents(events).at(-1)?.payload.status).toBe(status);
      }
      expect(taskEvents(events).at(-1)?.payload.terminalReason).toBe("interrupted");
    });
  });

  it("demotes known children to last-seen on a failed read and never fails the parent", async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      const session = await startRunning(runtime, http, directory, "observe-failure");
      vi.spyOn(http.client.session, "active").mockResolvedValue({ ses_child: { type: "running" } });
      addChild(http, session);
      await runtime.reconcile(session);
      const list = vi
        .spyOn(http.client.session, "list")
        .mockRejectedValue(new Error("synthetic list failure"));
      await runtime.reconcile(session);
      expect(list).toHaveBeenCalled();
      const demoted = taskEvents(events).at(-1)!;
      expect(demoted.payload).toMatchObject({ status: "inProgress", activityFresh: false });
      expect(demoted.payload.freshness.providerRevision).toBe(2_000);
      expect(demoted.payload.freshness.observedOrdinal).toBeGreaterThan(
        taskEvents(events)[0]!.payload.freshness.observedOrdinal,
      );
      expect(session.session.status).not.toBe("error");
      expect(session.row?.state).toBe("accepted");
      await runtime.reconcile(session);
      expect(taskEvents(events)).toHaveLength(2); // Demotion is emitted once.
    });
  });

  it("stays inert without a subagent call, a hint, or a live child", async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      const session = await startRunning(runtime, http, directory, "observe-inert", false);
      addChild(http, session);
      const list = vi.spyOn(http.client.session, "list");
      await runtime.reconcile(session);
      expect(list).not.toHaveBeenCalled();
      expect(taskEvents(events)).toHaveLength(0);
    });
  });

  it("refreshes after an EventHub child hint, through the coalesced repair queue", async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      const session = await startRunning(runtime, http, directory, "observe-hint", false);
      await runtime.reconcile(session);
      addChild(http, session);
      vi.spyOn(http.client.session, "active").mockResolvedValue({ ses_child: { type: "running" } });
      http.source.push({
        id: "created-child",
        type: "session.created",
        created: 1,
        durable: { aggregateID: "ses_child", seq: 0, version: 1 },
        data: {
          sessionID: "ses_child",
          parentID: session.native.id,
          projectID: "synthetic",
          location: { directory },
          slug: "child",
          version: "2.0.26",
        },
      });
      await vi.waitFor(() => expect(taskEvents(events)).toHaveLength(1));
      expect(taskEvents(events)[0]?.payload.nativeId).toBe("ses_child");
    });
  });
});

describe("OpenCode v2 native subagents stay denied (G4 not passed)", () => {
  it("denies the subagent action in every runtime mode", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
      expect(v2PermissionEffect(v2SharedToolPolicy(mode, undefined, true), "subagent", "*")).toBe(
        "deny",
      );
      const local = v2LocalToolPolicy(mode, true, true, {
        nativeWorkspace: true,
        profileRoot: "/owned/profile",
        boundedFiles: true,
      });
      expect(v2PermissionEffect(local, "subagent", "*")).toBe("deny");
    }
  });
});
