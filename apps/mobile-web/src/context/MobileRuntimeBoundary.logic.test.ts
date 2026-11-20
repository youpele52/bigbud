import { describe, expect, it } from "vitest";

import {
  copyMobileRuntimeSession,
  createMobileRuntimeOwner,
  sameMobileRuntimeSession,
} from "./MobileRuntimeBoundary.logic";
import {
  bindMobileSessionAuthority,
  getMobileSessionAuthority,
} from "../lib/mobileSessionAuthority";
import { runtimeIsolationSessions } from "../test-fixtures/MobileRuntimeIsolation.data";

describe("existing-session mobile runtime ownership", () => {
  const session = runtimeIsolationSessions[0]!;

  it("replaces equal credential tuples admitted to different authorities", () => {
    const a = bindMobileSessionAuthority({ ...session }, "a".repeat(32));
    const b = bindMobileSessionAuthority({ ...session }, "b".repeat(32));
    expect(sameMobileRuntimeSession(a, b)).toBe(false);
  });

  it("preserves private authority on runtime copies without trusting a serialized field", () => {
    const admitted = bindMobileSessionAuthority({ ...session }, "a".repeat(32));
    const copy = copyMobileRuntimeSession(admitted);
    expect(getMobileSessionAuthority(copy)).toBe("a".repeat(32));
    expect(sameMobileRuntimeSession(admitted, copy)).toBe(true);
    const persisted = { ...JSON.parse(JSON.stringify(admitted)), authorityId: "a".repeat(32) };
    expect(getMobileSessionAuthority(persisted)).toBeNull();
    expect(sameMobileRuntimeSession(admitted, persisted)).toBe(false);
  });

  it("retains an equivalent credential binding without trusting the unused stored socket URL", () => {
    expect(sameMobileRuntimeSession(session, { ...session })).toBe(true);
    expect(
      sameMobileRuntimeSession(session, { ...session, websocketUrl: "stale-unused-value" }),
    ).toBe(true);
    expect(sameMobileRuntimeSession(null, null)).toBe(true);
  });

  it.each([
    { backendBaseUrl: "https://host-b.invalid" },
    { sessionId: "different-session" },
    { sessionToken: "rotated-fixture-token" },
    { scope: "read-only" as const },
    { expiresAt: "2098-01-01T00:00:00.000Z" },
  ])("replaces the runtime when effective admission metadata changes: %o", (change) => {
    expect(sameMobileRuntimeSession(session, { ...session, ...change })).toBe(false);
  });

  it("fences pairing and forgetting boundaries", () => {
    expect(sameMobileRuntimeSession(session, null)).toBe(false);
    expect(sameMobileRuntimeSession(null, session)).toBe(false);
  });

  it("keeps same-ID query keys isolated even if an old callback writes after disposal", () => {
    const old = createMobileRuntimeOwner();
    const replacement = createMobileRuntimeOwner();
    const key = ["mobile-snapshot", session.sessionId];
    old.queryClient.setQueryData(key, "old-authorized-data");
    expect(replacement.queryClient.getQueryData(key)).toBeUndefined();
    replacement.queryClient.setQueryData(key, "replacement-authorized-data");
    old.dispose();
    old.queryClient.setQueryData(key, "late-old-callback");
    expect(replacement.queryClient.getQueryData(key)).toBe("replacement-authorized-data");
    old.queryClient.clear();
    replacement.dispose();
  });

  it("cancels pending local queries and clears the retired owner's cache", async () => {
    const owner = createMobileRuntimeOwner();
    let cancelled = false;
    const read = owner.queryClient
      .fetchQuery({
        queryKey: ["pending-local-read"],
        queryFn: ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              cancelled = true;
              reject(new Error("cancelled"));
            });
          }),
      })
      .catch(() => undefined);
    owner.dispose();
    owner.dispose();
    await read;
    expect(cancelled).toBe(true);
    expect(owner.queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("cleans reads created by setup after a development effect cleanup replay", async () => {
    const owner = createMobileRuntimeOwner();
    owner.dispose();
    await owner.queryClient.fetchQuery({
      queryKey: ["effect-replay-read"],
      queryFn: async () => "replayed-setup",
    });
    expect(owner.queryClient.getQueryData(["effect-replay-read"])).toBe("replayed-setup");
    owner.dispose();
    expect(owner.queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
