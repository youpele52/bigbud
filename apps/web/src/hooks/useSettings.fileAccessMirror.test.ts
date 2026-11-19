import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  serverLevel: "none" as string,
  clientLevel: "unrestricted" as string,
  update: vi.fn(),
}));

vi.mock("~/rpc/serverState", () => ({
  getServerConfig: () => ({ settings: { search: { fileAccessLevel: state.serverLevel } } }),
}));
vi.mock("./useLocalStorage", () => ({
  getLocalStorageItem: () => ({ fileAccessPermissionLevel: state.clientLevel }),
}));
vi.mock("./useSettings", () => ({ updateServerSettings: state.update }));

import {
  FILE_ACCESS_MIRROR_STORAGE_KEY,
  mirrorFileAccessLevelToServer,
} from "./useSettings.fileAccessMirror";

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

describe("mirrorFileAccessLevelToServer", () => {
  beforeEach(() => {
    state.update.mockReset();
    state.serverLevel = "none";
    state.clientLevel = "unrestricted";
  });

  it("copies an earlier client choice to the server once", () => {
    const storage = memoryStorage();
    mirrorFileAccessLevelToServer(storage);
    mirrorFileAccessLevelToServer(storage);
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(state.update).toHaveBeenCalledWith({ search: { fileAccessLevel: "unrestricted" } });
    expect(storage.getItem(FILE_ACCESS_MIRROR_STORAGE_KEY)).toBe("1");
  });

  it("never overwrites a server value or mirrors none", () => {
    state.serverLevel = "common-folders";
    mirrorFileAccessLevelToServer(memoryStorage());
    state.serverLevel = "none";
    state.clientLevel = "none";
    mirrorFileAccessLevelToServer(memoryStorage());
    expect(state.update).not.toHaveBeenCalled();
  });
});
