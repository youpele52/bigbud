import { describe, expect, it } from "vitest";

import type { Thread } from "../../models/types";
import {
  makeRequestedPayload,
  makeResolvedPayload,
  modelChoiceActivity,
} from "../../components/chat/view/ThreadModelChoiceNotice.test.helpers";
import { syncDelegatedChildSummaries } from "./helpers.delegatedChildren.store";

function child(status: "idle" | "running"): Thread {
  return {
    id: "child" as never,
    projectId: "project" as never,
    title: "Child",
    session: {
      provider: "codex",
      status: "running",
      orchestrationStatus: status,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    },
    latestTurn: null,
    updatedAt: "2026-01-01T00:01:00.000Z",
  } as unknown as Thread;
}

describe("syncDelegatedChildSummaries", () => {
  it("refreshes a hydrated parent from live child state", () => {
    const parent = {
      id: "parent",
      delegatedChildren: [
        {
          threadId: "child",
          title: "Old child",
          projectId: null,
          workflowState: "idle",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as unknown as Thread;
    const result = syncDelegatedChildSummaries([parent, child("running")], child("running"));
    expect(result[0]?.delegatedChildren?.[0]).toMatchObject({
      title: "Child",
      projectId: "project",
      workflowState: "working",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
  });

  it("mirrors the tributary's model choice into the trunk's item (OD3)", () => {
    const parent = {
      id: "parent",
      delegatedChildren: [
        {
          threadId: "child",
          title: "Child",
          projectId: null,
          workflowState: "idle",
          updatedAt: "2026-01-01T00:00:00.000Z",
          modelChoice: {
            source: "linked",
            summary: { requested: { provider: "cursor" }, status: "pending" },
          },
        },
      ],
    } as unknown as Thread;
    const requested = modelChoiceActivity("requested", makeRequestedPayload());
    const held = { ...child("idle"), activities: [requested] } as Thread;
    const pending = syncDelegatedChildSummaries([parent, held], held);
    expect(pending[0]?.delegatedChildren?.[0]?.modelChoice).toMatchObject({
      source: "tributary",
      record: { status: "pending", choiceId: "choice-1" },
    });

    const resolved = {
      ...held,
      activities: [requested, modelChoiceActivity("resolved", makeResolvedPayload())],
    } as Thread;
    const next = syncDelegatedChildSummaries(pending, resolved);
    expect(next[0]?.delegatedChildren?.[0]?.modelChoice).toMatchObject({
      source: "tributary",
      record: { status: "resolved", outcome: "fallback" },
    });

    const withoutChoice = { ...child("idle"), activities: [] } as unknown as Thread;
    expect(
      syncDelegatedChildSummaries([parent, withoutChoice], withoutChoice)[0]?.delegatedChildren?.[0]
        ?.modelChoice,
    ).toMatchObject({ source: "linked" });
  });
});
