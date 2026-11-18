import { vi } from "vitest";

import type { BackendStorageIdentity } from "./backendScopedStorage";

export const IDENTITY_A: BackendStorageIdentity = {
  authority: { authorityId: "a".repeat(32) },
  installationFingerprint: `sha256:${"1".repeat(64)}`,
};
export const IDENTITY_B: BackendStorageIdentity = {
  authority: { authorityId: "b".repeat(32) },
  installationFingerprint: `sha256:${"2".repeat(64)}`,
};
export const PREFIX_A = `backend-v1:${"a".repeat(32)}:sha256:${"1".repeat(64)}:`;
export const PREFIX_B = `backend-v1:${"b".repeat(32)}:sha256:${"2".repeat(64)}:`;

/** Map-backed Storage whose methods are spies, so a test can assert every key it touched. */
export function createSpyStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  const storage = {
    entries,
    get length() {
      return entries.size;
    },
    key: vi.fn((index: number) => [...entries.keys()][index] ?? null),
    clear: vi.fn(() => entries.clear()),
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
  };
  return storage;
}
export type SpyStorage = ReturnType<typeof createSpyStorage>;

/** Every key the window read, wrote or removed. */
export function touchedKeys(storage: SpyStorage): string[] {
  return [
    ...storage.getItem.mock.calls,
    ...storage.setItem.mock.calls,
    ...storage.removeItem.mock.calls,
  ].map(([key]) => key);
}

/** Installs a minimal renderer window. `?backend=<id>` makes it a bound backend window. */
export function installWindow(storage: SpyStorage, search = ""): void {
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    localStorage: storage,
    location: { search },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
}
