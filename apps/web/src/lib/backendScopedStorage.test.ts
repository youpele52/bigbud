import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSpyStorage,
  IDENTITY_A,
  IDENTITY_B,
  installWindow,
  PREFIX_A,
  touchedKeys,
  type SpyStorage,
} from "./backendScopedStorage.test.helpers";

/** Fresh module graph per window: `useLocalStorage` captures `window.localStorage` on load. */
async function openWindow(storage: SpyStorage, search = "") {
  vi.resetModules();
  installWindow(storage, search);
  return {
    ...(await import("./backendScopedStorage")),
    ...(await import("../hooks/useLocalStorage")),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("backend-scoped storage keys", () => {
  it("uses the scoped delivery cursor identity as the prefix", async () => {
    const { backendStoragePrefix } = await openWindow(createSpyStorage());
    expect(backendStoragePrefix(IDENTITY_A)).toBe(PREFIX_A);
  });

  it("local_binding_reads_legacy_keys", async () => {
    const storage = createSpyStorage({ "bigbud:ui-state:v1": "legacy" });
    const { backendScopedKey, backendScopedLocalStorage, onBackendStorageReady } =
      await openWindow(storage);
    expect(backendScopedKey("bigbud:ui-state:v1")).toBe("bigbud:ui-state:v1");
    expect(backendScopedLocalStorage.getItem("bigbud:ui-state:v1")).toBe("legacy");
    backendScopedLocalStorage.setItem("bigbud:ui-state:v1", "next");
    expect([...storage.entries.keys()]).toEqual(["bigbud:ui-state:v1"]);
    // The local window never learns a backend identity, so stores never rehydrate.
    const listener = vi.fn();
    onBackendStorageReady(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("a bound window never touches legacy keys, before or after its identity is known", async () => {
    const storage = createSpyStorage({ "bigbud:ui-state:v1": "local", "drafts:v1": "local" });
    const {
      backendScopedKey,
      backendScopedLocalStorage,
      setBackendStorageIdentity,
      setLocalStorageItem,
      getLocalStorageItem,
      BACKEND_SCOPED_STORAGE_OPTIONS,
    } = await openWindow(storage, "?backend=prof-a");

    // Pending identity: inert, nothing is read or written at all.
    expect(backendScopedKey("bigbud:ui-state:v1")).toBeNull();
    expect(backendScopedLocalStorage.getItem("bigbud:ui-state:v1")).toBeNull();
    backendScopedLocalStorage.setItem("bigbud:ui-state:v1", "dropped");
    backendScopedLocalStorage.removeItem("drafts:v1");
    expect(touchedKeys(storage)).toEqual([]);

    setBackendStorageIdentity(IDENTITY_A);
    backendScopedLocalStorage.setItem("bigbud:ui-state:v1", "bound");
    expect(backendScopedLocalStorage.getItem("bigbud:ui-state:v1")).toBe("bound");
    backendScopedLocalStorage.removeItem("drafts:v1");
    setLocalStorageItem("recent", ["m"], Schema.Array(Schema.String), {
      ...BACKEND_SCOPED_STORAGE_OPTIONS,
      legacyKeys: ["recent:v0"],
    });
    expect(
      getLocalStorageItem("recent", Schema.Array(Schema.String), BACKEND_SCOPED_STORAGE_OPTIONS),
    ).toEqual(["m"]);

    expect(touchedKeys(storage).every((key) => key.startsWith(PREFIX_A))).toBe(true);
    expect(storage.entries.get("bigbud:ui-state:v1")).toBe("local");
    expect(storage.entries.get("drafts:v1")).toBe("local");
  });

  it("runs rehydration once when the identity arrives and keeps the first identity", async () => {
    const { onBackendStorageReady, setBackendStorageIdentity, backendScopedKey } = await openWindow(
      createSpyStorage(),
      "?backend=prof-a",
    );
    const listener = vi.fn();
    onBackendStorageReady(listener);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    setBackendStorageIdentity(IDENTITY_A);
    setBackendStorageIdentity(IDENTITY_B);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(backendScopedKey("k")).toBe(`${PREFIX_A}k`);
    expect(warn).toHaveBeenCalledOnce();
    // Registered after the identity is known: creation-time reads were already scoped.
    const late = vi.fn();
    onBackendStorageReady(late);
    expect(late).not.toHaveBeenCalled();
  });

  it("device-global helpers keep plain keys in a bound window", async () => {
    const storage = createSpyStorage();
    const { setBackendStorageIdentity, setLocalStorageItem } = await openWindow(
      storage,
      "?backend=prof-a",
    );
    setBackendStorageIdentity(IDENTITY_A);
    setLocalStorageItem("bigbud:theme-ish", "dark", Schema.String);
    expect(storage.entries.has("bigbud:theme-ish")).toBe(true);
  });
});
