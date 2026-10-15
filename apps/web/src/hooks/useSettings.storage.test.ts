import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type TerminalFontFamily,
} from "@bigbud/contracts/core/settings.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./useLocalStorage";
import {
  CLIENT_SETTINGS_LEGACY_KEYS,
  CLIENT_SETTINGS_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_OPTIONS,
  migrateHiddenComposerProvidersToServer,
} from "./useSettings.storage";

const read = () =>
  getLocalStorageItem(
    CLIENT_SETTINGS_STORAGE_KEY,
    ClientSettingsSchema,
    CLIENT_SETTINGS_STORAGE_OPTIONS,
  );

beforeEach(() => {
  removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, CLIENT_SETTINGS_STORAGE_OPTIONS);
});

it.each(CLIENT_SETTINGS_LEGACY_KEYS)(
  "migrates and persists saved Meslo from %s without changing other settings",
  (key) => {
    const previous = {
      ...DEFAULT_CLIENT_SETTINGS,
      terminalFontFamily: "meslo-nerd-font-mono" as const,
      terminalFontSize: 16,
      terminalGpuAcceleration: "off" as const,
      windowMaterial: "solid" as const,
      confirmThreadArchive: true,
      enableTaskCompletionToasts: false,
      contextWindowWarningThresholdTokens: 180_000,
    };
    setLocalStorageItem(key, previous, ClientSettingsSchema);
    const expected = { ...previous, terminalFontFamily: "jetbrains-mono-nerd-font" };
    expect(read()).toEqual(expected);
    expect(getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema)).toEqual(
      expected,
    );
    expect(getLocalStorageItem(key, ClientSettingsSchema)).toBeNull();
  },
);

it.each(["system-monospace", "jetbrains-mono-nerd-font"] satisfies TerminalFontFamily[])(
  "preserves an existing %s choice when migrating",
  (terminalFontFamily) => {
    const previous = { ...DEFAULT_CLIENT_SETTINGS, terminalFontFamily, terminalFontSize: 14 };
    setLocalStorageItem(CLIENT_SETTINGS_LEGACY_KEYS[0], previous, ClientSettingsSchema);
    expect(read()).toEqual(previous);
  },
);

it("never remigrates Meslo when it is selected after the upgrade", () => {
  setLocalStorageItem(
    CLIENT_SETTINGS_LEGACY_KEYS[0],
    {
      ...DEFAULT_CLIENT_SETTINGS,
      terminalFontFamily: "meslo-nerd-font-mono",
    },
    ClientSettingsSchema,
  );
  expect(read()?.terminalFontFamily).toBe("jetbrains-mono-nerd-font");
  const selected = {
    ...DEFAULT_CLIENT_SETTINGS,
    terminalFontFamily: "meslo-nerd-font-mono" as const,
  };
  setLocalStorageItem(
    CLIENT_SETTINGS_STORAGE_KEY,
    selected,
    ClientSettingsSchema,
    CLIENT_SETTINGS_STORAGE_OPTIONS,
  );
  expect(read()).toEqual(selected);
  expect(read()).toEqual(selected);
});

it("prefers the current saved choice over stale legacy defaults", () => {
  setLocalStorageItem(
    CLIENT_SETTINGS_STORAGE_KEY,
    {
      ...DEFAULT_CLIENT_SETTINGS,
      terminalFontFamily: "meslo-nerd-font-mono",
    },
    ClientSettingsSchema,
  );
  setLocalStorageItem(
    CLIENT_SETTINGS_LEGACY_KEYS[0],
    DEFAULT_CLIENT_SETTINGS,
    ClientSettingsSchema,
  );
  expect(read()?.terminalFontFamily).toBe("meslo-nerd-font-mono");
});

describe("hidden composer providers move to the server (OD1)", () => {
  const makeStorage = (entries: Record<string, unknown>) => {
    const store = new Map(
      Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]),
    );
    return {
      read: (key: string) => JSON.parse(store.get(key) ?? "null") as unknown,
      storage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    };
  };

  it("patches an empty server list once, then drops the local key", () => {
    const { read: readRaw, storage } = makeStorage({
      [CLIENT_SETTINGS_STORAGE_KEY]: {
        terminalFontSize: 15,
        hiddenComposerProviders: ["copilot", "not-a-provider", "pi"],
      },
    });
    const patchServer = vi.fn();
    const migrate = () =>
      migrateHiddenComposerProvidersToServer({
        serverHiddenComposerProviders: [],
        patchServer,
        storage,
      });
    expect(migrate()).toBe("migrated");
    expect(patchServer).toHaveBeenCalledWith(["copilot", "pi"]);
    expect(readRaw(CLIENT_SETTINGS_STORAGE_KEY)).toEqual({ terminalFontSize: 15 });
    expect(migrate()).toBe("none");
    expect(patchServer).toHaveBeenCalledOnce();
  });

  it("keeps a non-empty server list and still drops the local key", () => {
    const { read: readRaw, storage } = makeStorage({
      [CLIENT_SETTINGS_LEGACY_KEYS[0]]: { hiddenComposerProviders: ["copilot"] },
    });
    const patchServer = vi.fn();
    expect(
      migrateHiddenComposerProvidersToServer({
        serverHiddenComposerProviders: ["cursor"],
        patchServer,
        storage,
      }),
    ).toBe("dropped");
    expect(patchServer).not.toHaveBeenCalled();
    expect(readRaw(CLIENT_SETTINGS_LEGACY_KEYS[0])).toEqual({});
  });
});
