import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { acknowledgeThreadOpen } from "./threadOrganizationAcknowledge";

const fixture = vi.hoisted(() => ({
  summaries: {} as Record<string, { organization?: { state: string; revision: number } }>,
  dispatch: vi.fn(),
}));
vi.mock("../rpc/nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: fixture.dispatch } }),
}));
vi.mock("../stores/main", () => ({
  useStore: { getState: () => ({ sidebarThreadsById: fixture.summaries }) },
}));

const threadId = ThreadId.makeUnsafe("thread-ack");
const organization = (state: string, revision: number) => ({
  state,
  revision,
  changedAt: null,
  snooze: null,
});

describe("acknowledgeThreadOpen", () => {
  beforeEach(() => {
    fixture.dispatch.mockReset().mockResolvedValue({ sequence: 1 });
    fixture.summaries = {};
  });

  it("moves an opened Needs you thread to Present, fenced by the seen revision", () => {
    fixture.summaries[threadId] = { organization: organization("needs-you", 4) };
    acknowledgeThreadOpen(threadId);
    acknowledgeThreadOpen(threadId);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.organization.move",
        threadId,
        state: "present",
        expectedRevision: 4,
      }),
    );
  });

  it("leaves every other state alone", () => {
    for (const state of ["present", "later", "done"]) {
      fixture.summaries[threadId] = { organization: organization(state, 1) };
      acknowledgeThreadOpen(threadId);
    }
    acknowledgeThreadOpen(ThreadId.makeUnsafe("unknown-thread"));
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("allows a retry after a failed dispatch", async () => {
    fixture.summaries[threadId] = { organization: organization("needs-you", 9) };
    fixture.dispatch.mockRejectedValueOnce(new Error("offline"));
    acknowledgeThreadOpen(threadId);
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    acknowledgeThreadOpen(threadId);
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });
});
