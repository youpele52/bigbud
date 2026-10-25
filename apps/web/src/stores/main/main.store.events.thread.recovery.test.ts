import { MessageId } from "@bigbud/contracts";
import type { ThreadRecovery } from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvents } from "./events.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

const thread = makeThread();
const continuing: ThreadRecovery = {
  status: "continuing",
  reason: "interrupted-by-sleep",
  toolSummary: null,
  attempt: 1,
  provider: "codex",
  messageId: MessageId.makeUnsafe("user-1"),
  updatedAt: "2026-10-22T10:00:00.000Z",
};
const updated = (recovery: ThreadRecovery | null) =>
  makeEvent("thread.recovery-updated", {
    threadId: thread.id,
    recovery,
    messageId: continuing.messageId,
    createdAt: "2026-10-22T10:00:00.000Z",
  });

describe("thread.recovery-updated", () => {
  it("stores the recovery state and keeps the sidebar pill working while continuing", () => {
    const state = applyOrchestrationEvents(makeState(thread), [updated(continuing)]);
    expect(state.threads[0]?.recovery).toEqual(continuing);
    expect(state.sidebarThreadsById[thread.id]?.recoveryStatus).toBe("continuing");
  });

  it("clears the notice when the server clears recovery", () => {
    const state = applyOrchestrationEvents(makeState(thread), [updated(continuing), updated(null)]);
    expect(state.threads[0]?.recovery).toBeNull();
    expect(state.sidebarThreadsById[thread.id]?.recoveryStatus).toBeNull();
  });
});
