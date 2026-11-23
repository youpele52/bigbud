import {
  RuntimeRequestId,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.helpers.ts";
import { RuntimeActivityGovernor } from "./ProviderRuntimeIngestion.activityGovernor.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const turnId = TurnId.makeUnsafe("turn-1");
const createdAt = "2026-07-26T00:00:00.000Z";

function activity(input: {
  readonly id: string;
  readonly kind: string;
  readonly tone?: OrchestrationThreadActivity["tone"];
  readonly payload?: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(input.id),
    createdAt,
    tone: input.tone ?? "tool",
    kind: input.kind,
    summary: input.kind,
    payload: input.payload ?? {},
    turnId,
  };
}

function take(
  governor: RuntimeActivityGovernor,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
) {
  return governor.take({ threadId, turnId, activities });
}

describe("RuntimeActivityGovernor", () => {
  it("bounds repetitive category rows with one stable aggregate diagnostic", () => {
    const governor = new RuntimeActivityGovernor({ maxRowsPerCategory: 1 });

    expect(take(governor, [activity({ id: "tool-1", kind: "tool.progress" })])).toHaveLength(1);
    const firstSuppression = take(governor, [activity({ id: "tool-2", kind: "tool.progress" })]);
    const repeatedSuppression = take(governor, [activity({ id: "tool-3", kind: "tool.progress" })]);

    expect(firstSuppression).toMatchObject([
      {
        id: "activity-suppressed:thread-1:turn-1:tool",
        kind: "runtime.activity.suppressed",
        payload: { category: "tool", suppressed: 1 },
      },
    ]);
    expect(repeatedSuppression).toMatchObject([
      {
        id: "activity-suppressed:thread-1:turn-1:tool",
        payload: { category: "tool", suppressed: 2 },
      },
    ]);
  });

  it("preserves terminal, error, approval, and user-input activities over budget", () => {
    const governor = new RuntimeActivityGovernor({ maxRowsPerTurn: 0 });

    expect(
      take(governor, [
        activity({ id: "completed", kind: "tool.completed" }),
        activity({ id: "failure", kind: "tool.progress", tone: "error" }),
        activity({ id: "input", kind: "user-input.requested" }),
      ]),
    ).toHaveLength(3);
  });

  it("preserves converted approval opens and resolutions and both response failures over budget", () => {
    const governor = new RuntimeActivityGovernor({ maxRowsPerTurn: 0, maxBytesPerTurn: 0 });
    const common = {
      provider: "claudeAgent",
      sessionEpoch: 42,
      threadId,
      turnId,
      createdAt,
      requestId: RuntimeRequestId.makeUnsafe("request-1"),
    } as const;
    const opened = runtimeEventToActivities({
      ...common,
      type: "request.opened",
      eventId: EventId.makeUnsafe("open"),
      payload: { requestType: "command_execution_approval", detail: "pwd" },
    });
    const resolved = runtimeEventToActivities({
      ...common,
      type: "request.resolved",
      eventId: EventId.makeUnsafe("resolved"),
      payload: { requestType: "command_execution_approval", decision: "accept" },
    });
    const inputResolved = runtimeEventToActivities({
      ...common,
      type: "user-input.resolved",
      eventId: EventId.makeUnsafe("input-resolved"),
      payload: { answers: {} },
    });
    const activities = [
      ...opened,
      ...resolved,
      ...inputResolved,
      activity({ id: "approval-failed", kind: "provider.approval.respond.failed", tone: "info" }),
      activity({ id: "input-failed", kind: "provider.user-input.respond.failed", tone: "info" }),
    ];
    expect(activities.map(({ kind }) => kind)).toEqual([
      "approval.requested",
      "approval.resolved",
      "user-input.resolved",
      "provider.approval.respond.failed",
      "provider.user-input.respond.failed",
    ]);
    expect(take(governor, activities)).toEqual(activities);
  });

  it("bounds updates for one logical activity and resets on turn completion", () => {
    const governor = new RuntimeActivityGovernor({ maxUpdatesPerIdentity: 1 });
    const progress = activity({ id: "tool-progress-1", kind: "tool.progress" });

    expect(take(governor, [progress])).toEqual([progress]);
    expect(take(governor, [progress])[0]?.kind).toBe("runtime.activity.suppressed");
    governor.clear({ threadId, turnId });
    expect(take(governor, [progress])).toEqual([progress]);
  });

  it("keeps the persisted identity count bounded during high-volume progress", () => {
    const governor = new RuntimeActivityGovernor({ maxRowsPerCategory: 2 });
    const activities = Array.from({ length: 50 }, (_, index) =>
      activity({ id: `tool-${index}`, kind: "tool.progress" }),
    );
    const result = take(governor, activities);

    expect(result).toHaveLength(50);
    expect(new Set(result.map((entry) => entry.id)).size).toBe(3);
    expect(result.at(-1)).toMatchObject({
      id: "activity-suppressed:thread-1:turn-1:tool",
      payload: { category: "tool", suppressed: 48 },
    });
  });

  it("enforces byte budgets independently for the turn, category, and identity", () => {
    const governor = new RuntimeActivityGovernor({
      maxBytesPerTurn: 2_000,
      maxBytesPerCategory: 2_000,
      maxBytesPerIdentity: 500,
    });
    const first = activity({
      id: "tool-1",
      kind: "tool.progress",
      payload: { detail: "x".repeat(250) },
    });

    expect(take(governor, [first])).toEqual([first]);
    expect(take(governor, [activity({ id: "tool-1", kind: "tool.progress" })])[0]).toMatchObject({
      kind: "runtime.activity.suppressed",
      payload: { category: "tool", suppressed: 1 },
    });
  });

  it("preserves terminal activities when byte budgets are exhausted", () => {
    const governor = new RuntimeActivityGovernor({ maxBytesPerTurn: 1 });

    expect(take(governor, [activity({ id: "completed", kind: "tool.completed" })])).toHaveLength(1);
  });
});
