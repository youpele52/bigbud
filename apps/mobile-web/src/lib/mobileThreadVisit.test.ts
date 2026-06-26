import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getThreadLastVisitedAt, markThreadVisited } from "./mobileThreadVisit";

function createLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

describe("mobileThreadVisit", () => {
  beforeEach(() => {
    const localStorage = createLocalStorageMock();
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("window", { localStorage });
  });

  it("records and reads the last visited timestamp for a thread", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    markThreadVisited(threadId, "2026-06-24T12:00:00.000Z");
    expect(getThreadLastVisitedAt(threadId)).toBe("2026-06-24T12:00:00.000Z");
  });
});
