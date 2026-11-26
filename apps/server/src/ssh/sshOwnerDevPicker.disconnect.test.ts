import { describe, expect, it, vi } from "vitest";

import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import type { PickerProofOwner } from "./sshOwnerPickerProof.client.session.ts";
import { REMOTE_TARGET_DISCONNECTED_MESSAGE } from "./sshTargetDisconnects.ts";

const input = { executionTargetId: "ssh://tester@127.0.0.1:3030" };
const folders = { path: "/fixtures", homePath: "/fixtures", folders: [], truncated: false };

function fixture(cancellable: boolean) {
  const started = Promise.withResolvers<AbortSignal | undefined>();
  const late = Promise.withResolvers<typeof folders>();
  const client = {
    listRemoteFolders: vi.fn<PickerProofOwner["listRemoteFolders"]>(() => {
      started.resolve(undefined);
      return late.promise;
    }),
    listAliases: vi.fn<PickerProofOwner["listAliases"]>(),
    inspectTrust: vi.fn<PickerProofOwner["inspectTrust"]>(),
    approveTrust: vi.fn<PickerProofOwner["approveTrust"]>(),
    connect: vi.fn<PickerProofOwner["connect"]>().mockResolvedValue({ state: "connected" }),
    disconnect: vi
      .fn<PickerProofOwner["disconnect"]>()
      .mockResolvedValue({ state: "disconnected" }),
    close: vi.fn<PickerProofOwner["close"]>().mockResolvedValue(undefined),
  };
  const listWithCancellation = vi.fn(
    (_client: typeof client, _input: typeof input, signal: AbortSignal) => {
      started.resolve(signal);
      return new Promise<typeof folders>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("listCancelled")), { once: true });
        void late.promise.then(resolve);
      });
    },
  );
  const picker = makeSshOwnerDevPicker({
    ...input,
    host: "[127.0.0.1]:3030",
    startOwner: async () => client,
    ...(cancellable ? { listWithCancellation } : {}),
  });
  return { client, picker, started, late, listWithCancellation };
}

describe("development SSH picker Disconnect fence", () => {
  it.each([true, false])(
    "discards an in-flight read and its queued waiter when Disconnect is requested (cancellable %s)",
    async (cancellable) => {
      const { client, picker, started, late } = fixture(cancellable);
      try {
        const active = picker.listRemoteFolders(input);
        void active.catch(() => undefined);
        const queued = picker.listRemoteFolders({ ...input, path: "~/queued" });
        void queued.catch(() => undefined);
        const signal = await started.promise;
        const disconnected = picker.disconnectExecutionTarget(input);
        if (cancellable) expect(signal?.aborted).toBe(true);
        late.resolve(folders);
        await expect(active).rejects.toThrow(REMOTE_TARGET_DISCONNECTED_MESSAGE);
        await expect(queued).rejects.toThrow(REMOTE_TARGET_DISCONNECTED_MESSAGE);
        await expect(disconnected).resolves.toEqual({ ...input, disconnected: true });
        // Only the read that had already reached the owner was dispatched.
        expect(client.listRemoteFolders.mock.calls.length).toBe(cancellable ? 0 : 1);
        expect(client.disconnect).toHaveBeenCalledOnce();
      } finally {
        late.resolve(folders);
        await picker.close();
      }
    },
  );

  it("does not fence reads after the Disconnect request or for another target", async () => {
    const { client, picker, late } = fixture(false);
    late.resolve(folders);
    try {
      await expect(
        picker.disconnectExecutionTarget({ executionTargetId: `${input.executionTargetId}?x` }),
      ).rejects.toThrow();
      await picker.disconnectExecutionTarget(input);
      await expect(picker.listRemoteFolders(input)).resolves.toEqual(folders);
      expect(client.listRemoteFolders).toHaveBeenCalledOnce();
    } finally {
      await picker.close();
    }
  });
});
