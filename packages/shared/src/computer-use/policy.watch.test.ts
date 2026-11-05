import { COMPUTER_USE_POLICY_FORMAT } from "@bigbud/contracts/core/settings.computerUsePolicy";
import { describe, expect, it } from "vitest";

import { sealPolicy } from "./policy.digest";
import { type PolicyIdentity, type PolicyWatchInput, reconcilePolicyWatch } from "./policy.watch";

const seal = (revision: string, enabled: boolean) => {
  const result = sealPolicy({
    format: COMPUTER_USE_POLICY_FORMAT,
    authorityId: "authority-1",
    revision,
    enabled,
    disallowedApps: [],
    defaultDeliveryMode: "foreground",
    checkInIntervalMs: 600_000,
    actionTimeoutMs: 900_000,
    diagnosticMetadataEnabled: false,
  });
  if (!result.ok) throw new Error("seal");
  return JSON.parse(JSON.stringify(result.group)) as Record<string, unknown> & PolicyIdentity;
};
const current = seal("7", true);
const next = seal("8", false);
const identity = ({ authorityId, revision, digest }: PolicyIdentity): PolicyIdentity => ({
  authorityId,
  revision,
  digest,
});
const watch = (settings: unknown, overrides: Partial<PolicyWatchInput> = {}) =>
  reconcilePolicyWatch({
    reread: { kind: "document", settings },
    expected: identity(current),
    pendingApply: null,
    ...overrides,
  });

describe("reconcilePolicyWatch", () => {
  it("never pauses for an ordinary save that keeps the exact protected group", () => {
    // Unrelated settings changed and keys reordered by an atomic rename.
    const saved = { theme: "dark", computerUsePolicy: { ...current } };
    expect(watch(saved)).toEqual({ kind: "unchanged" });
  });

  it("recognizes only this server's own pending Apply", () => {
    const applied = { computerUsePolicy: next };
    expect(watch(applied, { pendingApply: identity(next) })).toEqual({
      kind: "own_apply",
      group: next,
    });
    // The same valid group without a matching pending Apply is an external edit.
    expect(watch(applied)).toEqual({ kind: "fence", reason: "changed" });
    expect(watch(applied, { pendingApply: { ...identity(next), digest: "0".repeat(64) } })).toEqual(
      { kind: "fence", reason: "changed" },
    );
  });

  it("fences missing, unreadable, corrupt and tampered policy", () => {
    expect(watch({ theme: "dark" })).toEqual({ kind: "fence", reason: "missing" });
    expect(
      reconcilePolicyWatch({
        reread: { kind: "unreadable" },
        expected: identity(current),
        pendingApply: null,
      }),
    ).toEqual({ kind: "fence", reason: "unreadable" });
    expect(watch(null)).toEqual({ kind: "fence", reason: "corrupt" });
    expect(watch([])).toEqual({ kind: "fence", reason: "corrupt" });
    expect(watch({ computerUsePolicy: { ...current, enabled: false } })).toEqual({
      kind: "fence",
      reason: "digest_mismatch",
    });
    expect(watch({ computerUsePolicy: { ...current, extra: 1 } })).toEqual({
      kind: "fence",
      reason: "corrupt",
    });
    expect(watch({ computerUsePolicy: { ...current, format: "future.v9" } })).toEqual({
      kind: "fence",
      reason: "unsupported_format",
    });
    // An older valid group restored over a newer one is also a change.
    expect(watch({ computerUsePolicy: seal("6", true) })).toEqual({
      kind: "fence",
      reason: "changed",
    });
  });

  it("before any binding there is nothing to protect, but a new group still fences", () => {
    expect(watch({ theme: "dark" }, { expected: null })).toEqual({ kind: "unchanged" });
    expect(watch({ computerUsePolicy: current }, { expected: null })).toEqual({
      kind: "fence",
      reason: "changed",
    });
  });
});
