import { ThreadId } from "@bigbud/contracts";
import type { ThreadSummary } from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import type { ThreadOrganization } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent } from "./events.store";
import { appendOrganizationPage } from "./helpers.organization.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";
import { buildSidebarThreadSummary } from "./mappers.store";

const organization = (
  state: ThreadOrganization["state"],
  revision: number,
): ThreadOrganization => ({
  state,
  revision,
  changedAt: "2026-10-30T00:00:00.000Z",
  snooze: null,
});

const summary = (id: string, org: ThreadOrganization): ThreadSummary => ({
  id: ThreadId.makeUnsafe(id),
  projectId: "project-elsewhere" as ThreadSummary["projectId"],
  title: id,
  purpose: "standard",
  elevatorSummary: null,
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  providerRuntimeExecutionTargetId: "local",
  workspaceExecutionTargetId: "local",
  executionTargetId: "local",
  branch: null,
  worktreePath: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
  latestUserMessageAt: null,
  pinnedAt: null,
  organization: org,
  sessionStatus: null,
  providerName: null,
  activeTurnId: null,
  latestTurnState: null,
  isWatching: false,
  isWatched: false,
  isDelegated: false,
  isAwaitingApproval: false,
});

const page = (threads: ThreadSummary[]) => ({
  projectionSequence: 5,
  state: "later" as const,
  threads,
});

describe("Inyosira store helpers", () => {
  it("adds page threads without giving them project membership", () => {
    const state = makeState(makeThread());
    const next = appendOrganizationPage(
      state,
      page([summary("thread-later", organization("later", 2))]),
    );
    expect(next.sidebarThreadsById["thread-later"]?.organization?.state).toBe("later");
    expect(next.threads.some((thread) => thread.id === "thread-later")).toBe(true);
    expect(next.threadIdsByProjectId).toBe(state.threadIdsByProjectId);
  });

  it("applies live moves to known threads and their summaries", () => {
    const thread = makeThread();
    const state = makeState(thread);
    state.sidebarThreadsById[thread.id] = buildSidebarThreadSummary(thread);
    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.organization-updated", {
        threadId: thread.id,
        organization: organization("done", 1),
        reason: "move",
      }),
    );
    expect(next.sidebarThreadsById[thread.id]?.organization?.state).toBe("done");
    expect(next.threads[0]?.organization?.state).toBe("done");
  });

  it("does not let a page fetched before a live move restore the older state", () => {
    const thread = makeThread({ organization: organization("done", 3) });
    const state = makeState(thread);
    state.sidebarThreadsById[thread.id] = buildSidebarThreadSummary(thread);
    const stale = summary(thread.id, organization("later", 2));
    const next = appendOrganizationPage(state, page([stale]));
    expect(next.sidebarThreadsById[thread.id]?.organization?.state).toBe("done");
    expect(next.threads[0]?.organization?.state).toBe("done");
  });
});
