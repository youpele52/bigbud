import { describe, expect, it } from "vitest";

import type { OrchestrationThreadActivity } from "@bigbud/contracts";
import type { Thread } from "../../models/types";
import {
  applyDelegationLinkedActivity,
  hydrateDelegatedChildModelChoices,
  removeDeletedDelegatedChildren,
} from "./events.store.delegations";

const parent = { id: "parent", delegatedChildren: [] } as unknown as Thread;
const linked = {
  id: "activity",
  tone: "info",
  kind: "delegation.child-linked",
  summary: "Delegated",
  payload: { childThreadId: "child", childProjectId: "project", childTitle: "Child" },
  turnId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as OrchestrationThreadActivity;

describe("delegated child lifecycle", () => {
  it("adds only an authoritative delegation-linked activity", () => {
    const next = applyDelegationLinkedActivity(parent, linked);
    expect(next.delegatedChildren).toEqual([
      {
        threadId: "child",
        projectId: "project",
        title: "Child",
        workflowState: "idle",
        updatedAt: linked.createdAt,
      },
    ]);
    expect(applyDelegationLinkedActivity(parent, { ...linked, kind: "other" })).toBe(parent);
  });

  it("removes deleted delegated children", () => {
    const linkedParent = applyDelegationLinkedActivity(parent, linked);
    expect(
      removeDeletedDelegatedChildren(linkedParent, new Set(["child"])).delegatedChildren,
    ).toEqual([]);
  });

  it("reads the optional model choice summary and keeps a mirrored tributary record", () => {
    const summary = { requested: { provider: "cursor", model: "composer-1" }, status: "pending" };
    const next = applyDelegationLinkedActivity(parent, {
      ...linked,
      payload: { ...(linked.payload as object), modelChoice: summary },
    });
    expect(next.delegatedChildren?.[0]?.modelChoice).toEqual({ source: "linked", summary });

    const mirrored = {
      ...parent,
      delegatedChildren: [
        {
          ...next.delegatedChildren![0]!,
          modelChoice: { source: "tributary", record: { status: "resolved" } },
        },
      ],
    } as unknown as Thread;
    const relinked = applyDelegationLinkedActivity(mirrored, {
      ...linked,
      payload: { ...(linked.payload as object), modelChoice: summary },
    });
    expect(relinked.delegatedChildren?.[0]?.modelChoice).toMatchObject({ source: "tributary" });
  });

  it("keeps model choices when detail hydration replaces the child summaries", () => {
    const summary = { requested: { provider: "cursor" }, status: "pending" };
    const serverChild = {
      threadId: "child",
      projectId: "project",
      title: "Child",
      workflowState: "idle",
      updatedAt: linked.createdAt,
    } as never;
    const withLinked = {
      ...linked,
      payload: { ...(linked.payload as object), modelChoice: summary },
    };
    expect(hydrateDelegatedChildModelChoices([serverChild], undefined, [withLinked])).toEqual([
      { ...(serverChild as object), modelChoice: { source: "linked", summary } },
    ]);
    const mirrored = { source: "tributary", record: { status: "resolved" } } as never;
    expect(
      hydrateDelegatedChildModelChoices(
        [serverChild],
        [{ ...(serverChild as object), modelChoice: mirrored } as never],
        [withLinked],
      )[0]?.modelChoice,
    ).toBe(mirrored);
    expect(hydrateDelegatedChildModelChoices([serverChild], undefined, [])).toEqual([serverChild]);
  });
});
