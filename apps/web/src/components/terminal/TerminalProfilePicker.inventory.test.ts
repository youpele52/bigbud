import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import type { TerminalShellProfileInventory } from "@bigbud/contracts/workspace/terminal.shellProfiles.ts";
import { describe, expect, it, vi } from "vitest";
import { createTerminalProfileInventoryLoader } from "./TerminalProfilePicker.inventory";

const local: TerminalShellProfileInventory = {
  host: { kind: "local", hostId: "local" },
  profiles: [],
};
const remote: TerminalShellProfileInventory = {
  host: { kind: "ssh", hostId: "ssh:one" },
  profiles: [],
};
const api = (shellProfiles: unknown) => ({ terminal: { shellProfiles } }) as NativeApi;

describe("current-pane profile inventory", () => {
  it("passes both required pane IDs, without querying any local inventory", async () => {
    const shellProfiles = vi.fn(async () => remote);
    const publish = vi.fn();
    await createTerminalProfileInventoryLoader(() => api(shellProfiles), publish).load(
      "thread",
      "remote-pane",
    );
    expect(shellProfiles).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread",
      terminalId: "remote-pane",
    });
    expect(publish).toHaveBeenLastCalledWith({ inventory: remote, loading: false });
  });
  it("makes failures and unsupported discovery visible without fallback", async () => {
    const publish = vi.fn();
    const loader = createTerminalProfileInventoryLoader(
      () =>
        api(
          vi.fn(async () => {
            throw new Error("Remote denied");
          }),
        ),
      publish,
    );
    await loader.load("thread", "pane");
    expect(publish).toHaveBeenLastCalledWith({ error: "Remote denied", loading: false });
    await createTerminalProfileInventoryLoader(() => api(undefined), publish).load(
      "thread",
      "pane",
    );
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      error: expect.stringContaining("unavailable"),
      loading: false,
    });
  });
  it("suppresses old inventory and failure results after switching panes or unmounting", async () => {
    let resolve!: (value: TerminalShellProfileInventory) => void;
    let reject!: (error: Error) => void;
    const shellProfiles = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(remote)
      .mockImplementationOnce(
        () =>
          new Promise((_done, fail) => {
            reject = fail;
          }),
      );
    const publish = vi.fn();
    const loader = createTerminalProfileInventoryLoader(() => api(shellProfiles), publish);
    const first = loader.load("thread", "old-pane");
    await loader.load("thread", "remote-pane");
    resolve(local);
    await first;
    expect(publish).toHaveBeenLastCalledWith({ inventory: remote, loading: false });
    const pending = loader.load("thread", "old-pane");
    loader.invalidate();
    publish.mockClear();
    reject(new Error("old failure"));
    await pending;
    expect(publish).not.toHaveBeenCalled();
  });
});
