import { expect, it } from "vitest";
import {
  bindMobileSessionAuthority,
  getMobileSessionAuthority,
  mobileSessionStateScope,
} from "./mobileSessionAuthority";
import type { StoredMobileSession } from "./mobileSession";

const session = (): StoredMobileSession => ({
  sessionId: "same-session",
  sessionToken: "private-token",
  backendBaseUrl: "https://host.example",
  websocketUrl: "",
  scope: "thread-control",
  expiresAt: "2099-01-01T00:00:00Z",
});
it("uses only a private admitted binding and preserves legacy scope", () => {
  const legacy = session();
  expect(mobileSessionStateScope(legacy, "query")).toBe(legacy.sessionId);
  const admitted = bindMobileSessionAuthority(session(), "a".repeat(32));
  expect(getMobileSessionAuthority(admitted)).toBe("a".repeat(32));
  expect(getMobileSessionAuthority({ ...admitted, authorityId: "a".repeat(32) })).toBeNull();
  expect(getMobileSessionAuthority(JSON.parse(JSON.stringify(admitted)))).toBeNull();
  expect(mobileSessionStateScope(admitted, "query")).not.toContain(admitted.sessionToken);
});
it("separates identical session IDs by authority and state area without rebinding", () => {
  const a = bindMobileSessionAuthority(session(), "a".repeat(32));
  const b = bindMobileSessionAuthority(session(), "b".repeat(32));
  expect(mobileSessionStateScope(a, "query")).not.toBe(mobileSessionStateScope(b, "query"));
  expect(mobileSessionStateScope(a, "query")).not.toBe(mobileSessionStateScope(a, "replay"));
  expect(() => bindMobileSessionAuthority(a, "b".repeat(32))).toThrow("cannot change");
  expect(() => bindMobileSessionAuthority(session(), "not-an-authority")).toThrow();
});
