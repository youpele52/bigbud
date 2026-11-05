import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PERSISTED_INYOSIRA_STATE,
  persistInyosiraState,
  readPersistedInyosiraState,
} from "./inyosira.store.persistence";

afterEach(() => vi.unstubAllGlobals());

/** Models browser storage being blocked for both reads and writes. */
function unavailableStorage(): never {
  throw new Error("Storage unavailable");
}

describe("Inyosira sidebar persistence", () => {
  it("uses defaults when there is no browser", () => {
    vi.stubGlobal("window", undefined);
    expect(readPersistedInyosiraState()).toEqual(DEFAULT_PERSISTED_INYOSIRA_STATE);
    expect(() => persistInyosiraState(DEFAULT_PERSISTED_INYOSIRA_STATE)).not.toThrow();
  });

  it("round-trips the renamed arrangement and collapsed states through the new key", () => {
    const values = new Map<string, string>();
    const getItem = vi.fn((key: string) => values.get(key) ?? null);
    const setItem = vi.fn((key: string, value: string) => values.set(key, value));
    vi.stubGlobal("window", { localStorage: { getItem, setItem } });
    const state = { arrangement: "inyosira", collapsedStates: ["later", "done"] } as const;

    persistInyosiraState(state);

    expect(setItem).toHaveBeenCalledExactlyOnceWith("bigbud:inyosira-ui:v1", JSON.stringify(state));
    expect(readPersistedInyosiraState()).toEqual(state);
    expect(getItem).toHaveBeenCalledExactlyOnceWith("bigbud:inyosira-ui:v1");
  });

  it.each([null, "{", "null"])("uses defaults for absent or malformed storage: %s", (raw) => {
    vi.stubGlobal("window", { localStorage: { getItem: () => raw } });
    expect(readPersistedInyosiraState()).toEqual(DEFAULT_PERSISTED_INYOSIRA_STATE);
  });

  it("discards unknown arrangements and collapsed states", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () =>
          JSON.stringify({ arrangement: "unknown", collapsedStates: ["later", "invalid", 42] }),
      },
    });
    expect(readPersistedInyosiraState()).toEqual({
      arrangement: "projects",
      collapsedStates: ["later"],
    });
  });

  it("tolerates unavailable storage when reading and writing", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: unavailableStorage, setItem: unavailableStorage },
    });
    expect(readPersistedInyosiraState()).toEqual(DEFAULT_PERSISTED_INYOSIRA_STATE);
    expect(() => persistInyosiraState(DEFAULT_PERSISTED_INYOSIRA_STATE)).not.toThrow();
  });
});
