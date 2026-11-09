import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts";
import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  dispatch: vi.fn(),
  api: { orchestration: {} },
  summaries: {} as Record<
    string,
    { organization: { state: ThreadOrganizationState; revision: number } }
  >,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => mocks.api }));
vi.mock("../../stores/main", () => ({
  useStore: { getState: () => ({ sidebarThreadsById: mocks.summaries }) },
}));
vi.mock("../../lib/orchestrationCommandRecovery", () => ({
  dispatchCommandWithOutcomeRecovery: mocks.dispatch,
}));

import { moveThreadsToState } from "./Sidebar.inyosira.actions";

const threadId = ThreadId.makeUnsafe("thread");
const otherId = ThreadId.makeUnsafe("other");

beforeEach(() => {
  mocks.toast.mockReset();
  mocks.dispatch.mockReset().mockResolvedValue({ sequence: 3 });
  mocks.summaries = {
    [threadId]: { organization: { state: "present", revision: 7 } },
    [otherId]: { organization: { state: "later", revision: 9 } },
  };
});

describe("manual organization move notifications", () => {
  it.each(["done", "later", "needs-you"] as const)(
    "moves from %s to Present without a success toast",
    async (from) => {
      mocks.summaries[threadId]!.organization.state = from;
      await moveThreadsToState([threadId], "present");
      expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
        mocks.api,
        expect.objectContaining({
          type: "thread.organization.move",
          threadId,
          state: "present",
          expectedRevision: 7,
          commandId: expect.any(String),
          createdAt: expect.any(String),
        }),
      );
      expect(mocks.toast).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["later", "Later", "10 minutes"],
    ["done", "Done", "Needs you sooner"],
    ["needs-you", "Needs you", "and no request remains"],
  ] as const)("preserves a manual Present move to %s", async (state, label, description) => {
    await moveThreadsToState([threadId], state);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
      mocks.api,
      expect.objectContaining({ state, expectedRevision: 7 }),
    );
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "success",
      title: `Moved to ${label}`,
      description: expect.stringContaining(description),
    });
  });

  it.each([
    ["later", "done", "Done"],
    ["later", "needs-you", "Needs you"],
    ["done", "later", "Later"],
    ["done", "needs-you", "Needs you"],
    ["needs-you", "later", "Later"],
    ["needs-you", "done", "Done"],
  ] as const)("preserves a manual %s move to %s", async (from, state, label) => {
    mocks.summaries[threadId]!.organization.state = from;
    await moveThreadsToState([threadId], state);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "success",
      title: `Moved to ${label}`,
      description: expect.any(String),
    });
  });

  it.each([
    ["present", "Present"],
    ["done", "Done"],
  ] as const)("still reports a failed manual move to %s", async (state, label) => {
    mocks.dispatch.mockRejectedValueOnce(new Error("offline"));
    await moveThreadsToState([threadId], state);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: `Couldn't move thread to ${label}`,
      description: "offline",
    });
  });

  it("reports a partial failure returning to Present without a success toast", async () => {
    mocks.summaries[threadId]!.organization.state = "done";
    mocks.dispatch.mockRejectedValueOnce(new Error("stale revision"));
    await moveThreadsToState([threadId, otherId], "present");
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ threadId, state: "present", expectedRevision: 7 }),
      expect.objectContaining({ threadId: otherId, state: "present", expectedRevision: 9 }),
    ]);
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Couldn't move 1 of 2 threads to Present",
      description: "stale revision",
    });
  });

  it("preserves success and error reporting for a partial move to Done", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("offline"));
    await moveThreadsToState([threadId, otherId], "done");
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.toast.mock.calls.map((call) => call[0])).toEqual([
      { type: "success", title: "Moved to Done", description: expect.any(String) },
      {
        type: "error",
        title: "Couldn't move 1 of 2 threads to Done",
        description: "offline",
      },
    ]);
  });

  it("keeps grouped success counts and does not toast accepted no-ops", async () => {
    await moveThreadsToState([threadId, otherId], "done");
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "success",
      title: "Moved 2 threads to Done",
      description: expect.any(String),
    });
    mocks.toast.mockClear();
    mocks.summaries[threadId]!.organization.state = "done";
    await moveThreadsToState([threadId], "done");
    expect(mocks.dispatch).toHaveBeenCalledTimes(3);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
