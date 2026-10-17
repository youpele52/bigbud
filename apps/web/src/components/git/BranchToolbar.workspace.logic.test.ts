import { describe, expect, it } from "vitest";
import { isThreadWorkspaceLocked } from "./BranchToolbar.workspace.logic";

describe("workspace execution locking", () => {
  it("allows stopped saved chats instead of treating their history as an active session", () => {
    expect(
      isThreadWorkspaceLocked({
        session: { status: "closed", orchestrationStatus: "stopped" },
        latestTurn: { state: "completed" },
      }),
    ).toBe(false);
    expect(isThreadWorkspaceLocked(undefined)).toBe(false);
  });
  it.each(["starting", "ready", "running", "recovering", "disconnected"])(
    "blocks %s ownership",
    (status) => {
      expect(isThreadWorkspaceLocked({ session: { status } })).toBe(true);
    },
  );
  it("blocks admission and queued execution before a provider session appears", () => {
    expect(isThreadWorkspaceLocked({ turnStartRequest: { outcome: "pending" } })).toBe(true);
    expect(isThreadWorkspaceLocked({ queuedPrompts: [{}] })).toBe(true);
    expect(isThreadWorkspaceLocked({ latestTurn: { state: "running" } })).toBe(true);
    expect(isThreadWorkspaceLocked({ pendingTurnControlOperation: {} })).toBe(true);
  });
});
