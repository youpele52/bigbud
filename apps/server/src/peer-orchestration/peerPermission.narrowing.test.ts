import { describe, expect, it } from "vitest";
import type { PeerGrant, PeerPermissionCeiling } from "@bigbud/contracts/server/remotePeer.ts";

import {
  evaluatePeerGrant,
  findPeerPermissionViolations,
  intersectPeerPermissions,
  isWithinPeerPermissionCeiling,
} from "./peerPermission.narrowing.ts";

const ceiling: PeerPermissionCeiling = {
  runtimeMode: "auto-accept-edits",
  providers: ["codex", "claudeAgent"],
  workspaceRoots: ["/srv/a", "/srv/b"],
};

const grant: PeerGrant = {
  grantId: "22345678-1234-4123-8123-123456789abc",
  coordinatorAuthorityId: "a".repeat(32),
  coordinatorKeyFingerprint: `sha256:${"b".repeat(64)}`,
  workerAuthorityId: "c".repeat(32),
  actions: ["delegate", "status"],
  ceiling,
  issuedAt: "2026-11-18T00:00:00.000Z",
  expiresAt: "2026-11-19T00:00:00.000Z",
  revokedAt: null,
};
const now = Date.parse("2026-11-18T12:00:00.000Z");
const evaluate = (overrides: Partial<Parameters<typeof evaluatePeerGrant>[0]> = {}) =>
  evaluatePeerGrant({
    grant,
    coordinatorAuthorityId: grant.coordinatorAuthorityId,
    coordinatorKeyFingerprint: grant.coordinatorKeyFingerprint,
    action: "delegate",
    nowMs: now,
    ...overrides,
  });

const code = (decision: ReturnType<typeof evaluate>) =>
  decision._tag === "denied" ? decision.code : "allowed";

describe("permission narrowing", () => {
  it("accepts equal or narrower permissions", () => {
    expect(isWithinPeerPermissionCeiling(ceiling, ceiling)).toBe(true);
    expect(
      isWithinPeerPermissionCeiling(
        { runtimeMode: "approval-required", providers: ["codex"], workspaceRoots: ["/srv/b"] },
        ceiling,
      ),
    ).toBe(true);
  });

  it("reports every way a grant exceeds its ceiling", () => {
    expect(
      findPeerPermissionViolations(
        { runtimeMode: "full-access", providers: ["codex", "pi"], workspaceRoots: ["/srv"] },
        ceiling,
      ),
    ).toEqual([
      { kind: "runtime-mode", requested: "full-access", ceiling: "auto-accept-edits" },
      { kind: "provider", provider: "pi" },
      { kind: "workspace", workspaceRoot: "/srv" },
    ]);
  });

  it("intersects to the narrower runtime mode and common scopes, or nothing", () => {
    expect(
      intersectPeerPermissions(ceiling, {
        runtimeMode: "full-access",
        providers: ["claudeAgent", "pi"],
        workspaceRoots: ["/srv/a"],
      }),
    ).toEqual({
      runtimeMode: "auto-accept-edits",
      providers: ["claudeAgent"],
      workspaceRoots: ["/srv/a"],
    });
    expect(intersectPeerPermissions(ceiling, { ...ceiling, providers: ["pi"] })).toBeUndefined();
  });
});

describe("evaluatePeerGrant", () => {
  it("allows a granted action within the ceiling", () => {
    expect(evaluate({ requested: ceiling })).toEqual({ _tag: "allowed" });
  });

  it("denies revoked, expired, mismatched, disallowed and wider requests with typed codes", () => {
    expect(code(evaluate({ grant: { ...grant, revokedAt: grant.issuedAt } }))).toBe(
      "grant-revoked",
    );
    expect(code(evaluate({ nowMs: Date.parse(grant.expiresAt) }))).toBe("grant-expired");
    expect(code(evaluate({ coordinatorAuthorityId: "d".repeat(32) }))).toBe("authority-mismatch");
    expect(code(evaluate({ coordinatorKeyFingerprint: `sha256:${"e".repeat(64)}` }))).toBe(
      "authority-mismatch",
    );
    expect(code(evaluate({ action: "cancel" }))).toBe("action-not-allowed");
    expect(code(evaluate({ requested: { ...ceiling, runtimeMode: "full-access" } }))).toBe(
      "permission-exceeds-ceiling",
    );
  });
});
