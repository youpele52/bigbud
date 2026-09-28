import { describe, expect, it } from "vitest";

import type { OrchestrationThreadActivity } from "@bigbud/contracts";
import type { Thread } from "../../models/types";
import {
  applyDelegationLinkedActivity,
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
});
