import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  thisComputer: true,
  clientLevel: "unrestricted" as string,
  request: vi.fn(async () => ({ success: true, granted: [], denied: [] })),
  hasApi: true,
}));

vi.mock("~/rpc/serverState", () => ({
  getServerConfig: () => ({ settings: { search: { thisComputer: state.thisComputer } } }),
}));
vi.mock("~/rpc/nativeApi", () => ({
  readNativeApi: () => (state.hasApi ? { fileAccess: { request: state.request } } : undefined),
}));
vi.mock("./useLocalStorage", () => ({
  getLocalStorageItem: () => ({ fileAccessPermissionLevel: state.clientLevel }),
}));

import {
  FILE_ACCESS_PROBE_STORAGE_KEY,
  probeFileAccessLevel,
  probeFileAccessOnStartup,
} from "./useSettings.fileAccessProbe";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("probeFileAccessOnStartup", () => {
  beforeEach(() => {
    state.request.mockClear();
    state.thisComputer = true;
    state.clientLevel = "unrestricted";
    state.hasApi = true;
  });

  it("probes an earlier choice once when Search this computer is on", async () => {
    const storage = memoryStorage();
    probeFileAccessOnStartup(storage);
    await settle();
    probeFileAccessOnStartup(storage);
    await settle();
    expect(state.request).toHaveBeenCalledTimes(1);
    expect(state.request).toHaveBeenCalledWith("unrestricted");
    expect(storage.getItem(FILE_ACCESS_PROBE_STORAGE_KEY)).toBe("unrestricted");
  });

  it("probes again only for a level that was never probed", async () => {
    const storage = memoryStorage();
    await probeFileAccessLevel("common-folders", storage);
    probeFileAccessOnStartup(storage);
    await settle();
    expect(state.request.mock.calls).toEqual([["common-folders"], ["unrestricted"]]);
  });

  it("skips no access, a disabled tier and a missing native API", async () => {
    state.clientLevel = "none";
    probeFileAccessOnStartup(memoryStorage());
    state.clientLevel = "common-folders";
    state.thisComputer = false;
    probeFileAccessOnStartup(memoryStorage());
    state.thisComputer = true;
    state.hasApi = false;
    const storage = memoryStorage();
    probeFileAccessOnStartup(storage);
    await settle();
    expect(state.request).not.toHaveBeenCalled();
    expect(storage.getItem(FILE_ACCESS_PROBE_STORAGE_KEY)).toBeNull();
  });

  it("does not record a probe that failed to run, so the next launch retries", async () => {
    state.request.mockRejectedValueOnce(new Error("bridge gone"));
    const storage = memoryStorage();
    await probeFileAccessLevel("unrestricted", storage);
    expect(storage.getItem(FILE_ACCESS_PROBE_STORAGE_KEY)).toBeNull();
  });
});
