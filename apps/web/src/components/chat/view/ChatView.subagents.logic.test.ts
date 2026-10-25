import { expect, it } from "vitest";
import { RuntimeTaskId, TurnId, type OrchestrationTask } from "@bigbud/contracts";
import type { Thread } from "../../../models/types";
import {
  countRunningBackgroundSubagents,
  describeThreadBackgroundWork,
  getThreadInterruptTurnId,
  hasOwnedV2DescendantWork,
} from "./ChatView.subagents.logic";

const child: OrchestrationTask = {
  id: RuntimeTaskId.makeUnsafe(`bbv2-owned:${"a".repeat(64)}`),
  kind: "providerSubagent",
  nativeId: "ses_child",
  status: "inProgress",
  subject: "Offline child",
  activityFresh: false,
  background: true,
  source: "observed",
  freshness: { sessionEpoch: "1", sourcePriority: 3, observedOrdinal: 1 },
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
};
const thread: Pick<Thread, "session" | "providerAgents"> = {
  session: {
    provider: "opencodeV2",
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
  },
  providerAgents: [child],
};

it("exposes Stop for owned background and orphaned foreground descendants even when last-seen, without root liveness", () => {
  expect(hasOwnedV2DescendantWork(thread)).toBe(true);
  expect(
    hasOwnedV2DescendantWork({ ...thread, providerAgents: [{ ...child, background: false }] }),
  ).toBe(true);
  expect(
    hasOwnedV2DescendantWork({ ...thread, providerAgents: [{ ...child, status: "stopped" }] }),
  ).toBe(false);
});

it("does not grant family control for other providers or merely observed native children", () => {
  expect(
    hasOwnedV2DescendantWork({ ...thread, session: { ...thread.session!, provider: "codex" } }),
  ).toBe(false);
  expect(
    hasOwnedV2DescendantWork({
      ...thread,
      providerAgents: [{ ...child, id: RuntimeTaskId.makeUnsafe("observed:child") }],
    }),
  ).toBe(false);
});

it.each(["pending spawn", "recovery uncertainty"])(
  "retains Stop for cardless %s without treating the idle root as running",
  () => {
    const retained = {
      ...thread,
      session: { ...thread.session!, retainedFamily: true },
      providerAgents: [],
    };
    expect(hasOwnedV2DescendantWork(retained)).toBe(true);
    expect(
      getThreadInterruptTurnId({
        ...retained,
        latestTurn: { turnId: TurnId.makeUnsafe("old-completed-turn") },
      }),
    ).toBeUndefined();
    expect(
      getThreadInterruptTurnId({
        ...retained,
        session: { ...retained.session, activeTurnId: TurnId.makeUnsafe("current-root") },
      }),
    ).toBe("current-root");
    expect(retained.session.status).toBe("ready");
    expect(
      hasOwnedV2DescendantWork({
        ...retained,
        session: { ...retained.session, retainedFamily: false },
      }),
    ).toBe(false);
  },
);

it.each(["claudeAgent", "codex", "copilot", "pi", "opencode"] as const)(
  "counts running background subagents on %s and keeps idle Stop off the completed turn",
  (provider) => {
    const background = { ...child, id: RuntimeTaskId.makeUnsafe(`${provider}:bg`) };
    const idle = {
      ...thread,
      session: { ...thread.session!, provider },
      providerAgents: [
        background,
        { ...background, id: RuntimeTaskId.makeUnsafe(`${provider}:pending`), status: "pending" },
        { ...background, id: RuntimeTaskId.makeUnsafe(`${provider}:fg`), background: false },
        { ...background, id: RuntimeTaskId.makeUnsafe(`${provider}:done`), status: "completed" },
        { ...background, id: RuntimeTaskId.makeUnsafe(`${provider}:task`), kind: "task" },
      ] satisfies OrchestrationTask[],
    };
    expect(countRunningBackgroundSubagents(idle)).toBe(2);
    expect(describeThreadBackgroundWork(idle)).toEqual({
      backgroundSubagentCount: 2,
      hasBackgroundWork: true,
    });
    expect(
      getThreadInterruptTurnId({
        ...idle,
        latestTurn: { turnId: TurnId.makeUnsafe("old-completed-turn") },
      }),
    ).toBeUndefined();

    const finished = { ...idle, providerAgents: [{ ...background, status: "stopped" as const }] };
    expect(describeThreadBackgroundWork(finished)).toEqual({
      backgroundSubagentCount: 0,
      hasBackgroundWork: false,
    });
    expect(
      getThreadInterruptTurnId({
        ...finished,
        latestTurn: { turnId: TurnId.makeUnsafe("old-completed-turn") },
      }),
    ).toBe("old-completed-turn");
  },
);

it("counts a foreground subagent still running fresh only while the root turn is idle", () => {
  const foreground = {
    ...child,
    id: RuntimeTaskId.makeUnsafe("codex:child"),
    background: false,
    activityFresh: true,
  };
  const idle = {
    ...thread,
    session: { ...thread.session!, provider: "codex" as const },
    providerAgents: [
      foreground,
      { ...foreground, id: RuntimeTaskId.makeUnsafe("codex:stale"), activityFresh: false },
    ],
  };
  expect(countRunningBackgroundSubagents(idle)).toBe(1);
  expect(
    countRunningBackgroundSubagents({
      ...idle,
      session: { ...idle.session, activeTurnId: TurnId.makeUnsafe("root") },
    }),
  ).toBe(0);
});
