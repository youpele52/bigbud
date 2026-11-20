import { ThreadId } from "@bigbud/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindMobileSessionAuthority, mobileSessionStateScope } from "./mobileSessionAuthority";
import type { StoredMobileSession } from "./mobileSession";
import {
  readMobileSelectedThread,
  writeMobileSelectedThread,
  clearMobileSelectedThreadForAuthority,
} from "./mobileHostSelection";
import { getThreadLastVisitedAt, markThreadVisited } from "./mobileThreadVisit";
import { clearReplacedMobileSessionCaches } from "../logic/mobileRecovery.session";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
};
function session(): StoredMobileSession {
  return {
    sessionId: "same",
    sessionToken: "private",
    backendBaseUrl: "https://host.example",
    websocketUrl: "",
    scope: "thread-control",
    expiresAt: "2099-01-01T00:00:00Z",
  };
}
beforeEach(() => {
  values.clear();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("keeps selections and visit markers apart for two authorities with identical IDs", () => {
  const a = bindMobileSessionAuthority(session(), "a".repeat(32));
  const b = bindMobileSessionAuthority(session(), "b".repeat(32));
  const thread = ThreadId.makeUnsafe("same-thread");
  expect(writeMobileSelectedThread(a, thread)).toBe(true);
  expect(readMobileSelectedThread(b)).toBeNull();
  expect(writeMobileSelectedThread(b, ThreadId.makeUnsafe("other-thread"))).toBe(true);
  expect(readMobileSelectedThread(a)).toBe(thread);
  markThreadVisited(thread, "2026-11-16T00:00:00Z", a);
  expect(getThreadLastVisitedAt(thread, b)).toBeUndefined();
  expect(getThreadLastVisitedAt(thread, a)).toBe("2026-11-16T00:00:00Z");
  expect(clearMobileSelectedThreadForAuthority("a".repeat(32))).toBe(true);
  expect(readMobileSelectedThread(b)).toBe("other-thread");
});
it("does not trust serialized identity fields or change legacy selection behavior", () => {
  const legacy = { ...session(), authorityId: "a".repeat(32) };
  expect(writeMobileSelectedThread(legacy, ThreadId.makeUnsafe("thread"))).toBe(false);
  expect(readMobileSelectedThread(legacy)).toBeNull();
  expect(values.size).toBe(0);
});
it("preserves existing selection when storage refuses a later update", () => {
  const a = bindMobileSessionAuthority(session(), "a".repeat(32));
  writeMobileSelectedThread(a, ThreadId.makeUnsafe("original"));
  vi.spyOn(storage, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(writeMobileSelectedThread(a, ThreadId.makeUnsafe("replacement"))).toBe(false);
  expect(readMobileSelectedThread(a)).toBe("original");
});
it("clears only the replaced authority's real query cache when all wire IDs match", () => {
  const a = bindMobileSessionAuthority(session(), "a".repeat(32));
  const b = bindMobileSessionAuthority(session(), "b".repeat(32));
  const scopeA = mobileSessionStateScope(a, "query");
  const scopeB = mobileSessionStateScope(b, "query");
  const client = new QueryClient();
  client.setQueryData(["mobile-snapshot", scopeA], { host: "A" });
  client.setQueryData(["mobile-snapshot", scopeB], { host: "B" });
  client.setQueryData(["mobile-thread", scopeA, "same-thread"], { host: "A" });
  client.setQueryData(["mobile-thread", scopeB, "same-thread"], { host: "B" });
  clearReplacedMobileSessionCaches(
    client,
    { ...a, stateScope: scopeA },
    { ...b, stateScope: scopeB },
  );
  expect(client.getQueryData(["mobile-snapshot", scopeA])).toBeUndefined();
  expect(client.getQueryData(["mobile-thread", scopeA, "same-thread"])).toBeUndefined();
  expect(client.getQueryData(["mobile-snapshot", scopeB])).toEqual({ host: "B" });
  expect(client.getQueryData(["mobile-thread", scopeB, "same-thread"])).toEqual({ host: "B" });
  client.clear();
});
it("keeps optional visit metadata from crashing the conversation when storage is unavailable", () => {
  const a = bindMobileSessionAuthority(session(), "a".repeat(32));
  vi.spyOn(storage, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(storage, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  expect(() => getThreadLastVisitedAt(ThreadId.makeUnsafe("thread"), a)).not.toThrow();
  expect(() => markThreadVisited(ThreadId.makeUnsafe("thread"), undefined, a)).not.toThrow();
});
