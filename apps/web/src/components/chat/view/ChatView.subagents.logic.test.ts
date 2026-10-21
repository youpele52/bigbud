import { expect, it } from "vitest";
import { RuntimeTaskId, TurnId, type OrchestrationTask } from "@bigbud/contracts";
import type { Thread } from "../../../models/types";
import { hasOwnedV2DescendantWork, getThreadInterruptTurnId } from "./ChatView.subagents.logic";

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
