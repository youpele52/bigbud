import { describe, expect, it } from "vitest";

import type { AppState } from "./main.store";
import { applyDelegatedChildRuntimeEvent } from "./events.store.delegatedRuntime";

const parent = {
  id: "parent",
  delegatedChildren: [
    {
      threadId: "unloaded-child",
      title: "Remote child",
      projectId: "other-project",
      workflowState: "idle",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("applyDelegatedChildRuntimeEvent", () => {
  it("updates a visible parent when the delegated child is not loaded", () => {
    const state = { threads: [parent] } as unknown as AppState;
    const next = applyDelegatedChildRuntimeEvent(state, {
      type: "thread.session-set",
      sequence: 1,
      eventId: "event" as never,
      aggregateKind: "thread",
      aggregateId: "unloaded-child" as never,
      occurredAt: "2026-01-01T00:01:00.000Z",
      commandId: null,
      causationEventId: null,
      payload: {
        threadId: "unloaded-child" as never,
        session: {
          threadId: "unloaded-child" as never,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
      },
    } as never);
    expect(next.threads[0]?.delegatedChildren?.[0]).toMatchObject({
      workflowState: "working",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
    expect(next.threads).toHaveLength(1);
  });
});
