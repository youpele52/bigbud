import { EventId, ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeApi = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("~/rpc/nativeApi", () => ({ readNativeApi: () => nativeApi.current }));

import { toastManager } from "~/components/ui/toast";
import { THREAD_DELETION_FAILED_TOAST_ID } from "~/logic/orchestration/thread-deletion.logic";
import {
  FORGET_REMOTE_SHELL_ACTION_LABEL,
  forgetRemoteShellAndDelete,
  forgetRemoteShellConfirmMessage,
  notifyFailedThreadDeletions,
  offerForgetRemoteShell,
} from "./threadDeletionRemoteShell";

const threadId = ThreadId.makeUnsafe("blocked-thread");

function deletionFailed(payload: Record<string, unknown>): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe("deletion-failed"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-11-21T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.deletion-failed",
    payload: { threadId, updatedAt: "2026-11-21T00:00:00.000Z", ...payload },
  } as OrchestrationEvent;
}

function makeApi(confirmed: boolean) {
  return {
    dialogs: { confirm: vi.fn(async () => confirmed) },
    terminal: {
      retainedShellOwners: vi.fn(async () => ({ hosts: ["iek3028.example"], count: 2 })),
      forgetRetainedShellOwners: vi.fn(async () => ({ forgotten: 2 })),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  nativeApi.current = null;
});

describe("thread deletion failure notices", () => {
  it("raises no toast for deletions background retention requested", () => {
    const add = vi.spyOn(toastManager, "add");
    notifyFailedThreadDeletions({
      events: [deletionFailed({ reason: "Busy.", initiator: "retention" })],
      failedThreadIds: [threadId],
      alreadyNotifiedThreadIds: new Set(),
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("still raises one toast for a deletion a person requested", () => {
    const add = vi.spyOn(toastManager, "add");
    notifyFailedThreadDeletions({
      events: [deletionFailed({ reason: "Busy." })],
      failedThreadIds: [threadId],
      alreadyNotifiedThreadIds: new Set(),
    });
    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0]?.[0]).toMatchObject({ description: "Busy." });
  });
});

describe("forget remote shell and delete", () => {
  it("warns that a shell on the host may still be running", () => {
    expect(forgetRemoteShellConfirmMessage(["iek3028.example"])).toBe(
      "Forget the remote shell on iek3028.example and delete this thread?\n\n" +
        "A shell on iek3028.example may still be running. bigbud cannot verify or stop it, and " +
        "will stop tracking it. Stop it on that host yourself if it is still needed or still running.",
    );
  });

  it("offers the action on the failure toast only when remote shell records hold the thread", async () => {
    const api = makeApi(true);
    nativeApi.current = api;
    const update = vi.spyOn(toastManager, "update");
    await offerForgetRemoteShell({ threadId, retryDelete: async () => {} });
    expect(api.terminal.retainedShellOwners).toHaveBeenCalledWith({ threadId });
    expect(update).toHaveBeenCalledWith(
      THREAD_DELETION_FAILED_TOAST_ID,
      expect.objectContaining({
        actionProps: expect.objectContaining({ children: FORGET_REMOTE_SHELL_ACTION_LABEL }),
      }),
    );

    update.mockClear();
    api.terminal.retainedShellOwners.mockResolvedValueOnce({ hosts: [], count: 0 });
    await offerForgetRemoteShell({ threadId, retryDelete: async () => {} });
    expect(update).not.toHaveBeenCalled();
  });

  it("forgets only after confirmation, then retries the deletion", async () => {
    const declined = makeApi(false);
    const retryDelete = vi.fn(async () => {});
    expect(
      await forgetRemoteShellAndDelete({
        api: declined as never,
        threadId,
        hosts: [],
        retryDelete,
      }),
    ).toBe(false);
    expect(declined.terminal.forgetRetainedShellOwners).not.toHaveBeenCalled();
    expect(retryDelete).not.toHaveBeenCalled();

    const accepted = makeApi(true);
    expect(
      await forgetRemoteShellAndDelete({
        api: accepted as never,
        threadId,
        hosts: ["iek3028.example"],
        retryDelete,
      }),
    ).toBe(true);
    expect(accepted.dialogs.confirm).toHaveBeenCalledWith(
      forgetRemoteShellConfirmMessage(["iek3028.example"]),
    );
    expect(accepted.terminal.forgetRetainedShellOwners).toHaveBeenCalledWith({ threadId });
    expect(retryDelete).toHaveBeenCalledOnce();
  });
});
