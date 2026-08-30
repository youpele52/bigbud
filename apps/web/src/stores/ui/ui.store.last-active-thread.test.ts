import { ThreadId } from "@bigbud/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PERSISTED_STATE_KEY,
  persistState,
  readPersistedState,
  setLastActiveThreadId,
} from "./ui.store";
import { initialState } from "./ui.store.types";

function installStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  return values;
}

afterEach(() => vi.unstubAllGlobals());

describe("last active thread UI persistence", () => {
  it("sets and clears the canonical thread id", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const active = setLastActiveThreadId(initialState, threadId);

    expect(active.lastActiveThreadId).toBe(threadId);
    expect(setLastActiveThreadId(active, null).lastActiveThreadId).toBeNull();
  });

  it("persists and hydrates the last active thread id", () => {
    const values = installStorage();
    const threadId = ThreadId.makeUnsafe("thread-1");

    persistState({ ...initialState, lastActiveThreadId: threadId });

    expect(readPersistedState().lastActiveThreadId).toBe(threadId);
    expect(JSON.parse(values.get(PERSISTED_STATE_KEY) ?? "{}")).toMatchObject({
      lastActiveThreadId: threadId,
    });
  });

  it("hydrates legacy UI state without a last active thread", () => {
    installStorage({
      "t3code:ui-state:v1": JSON.stringify({ projectsExpanded: false }),
    });

    expect(readPersistedState().lastActiveThreadId).toBeNull();
  });

  it("clears a malformed persisted candidate without dropping other UI state", () => {
    const values = installStorage({
      [PERSISTED_STATE_KEY]: JSON.stringify({
        chatsExpanded: false,
        lastActiveThreadId: "   ",
      }),
    });

    expect(readPersistedState()).toMatchObject({ chatsExpanded: false, lastActiveThreadId: null });
    expect(JSON.parse(values.get(PERSISTED_STATE_KEY) ?? "{}")).toEqual({
      chatsExpanded: false,
    });
  });

  it("keeps valid UI hydration when malformed-candidate repair cannot be written", () => {
    const raw = JSON.stringify({ chatsExpanded: false, lastActiveThreadId: " " });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => (key === PERSISTED_STATE_KEY ? raw : null),
        setItem: () => {
          throw new Error("storage unavailable");
        },
      },
    });

    expect(readPersistedState()).toMatchObject({
      chatsExpanded: false,
      lastActiveThreadId: null,
    });
  });
});
