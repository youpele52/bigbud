import { expect, it } from "vitest";
import type { ThreadOrganizationNativeOperation as OrganizationOperation } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
import { validateOrganizationProposal } from "./organizationProposal.validation.ts";
import type { OrganizationRow, OrganizationSchedulingSettings } from "./organizationProtocol.ts";

const now = 100000000;
const row: OrganizationRow = {
  threadId: "thread",
  factVersion: 3,
  organizationRevision: 2,
  section: 2,
  work: 1,
  actionable: false,
  attentionWatermark: 0,
  inactivityAtMs: 0,
  snoozeIdentity: "",
  eligible: true,
  inScope: true,
  manualAttentionWatermark: 0,
};
const operation: OrganizationOperation = {
  operationId: "operation",
  occurrenceId: "occurrence",
  attempt: 0,
  threadId: "thread",
  backendNonce: "owner",
  generation: 1,
  policyVersion: 1,
  factVersion: 3,
  expectedRevision: 2,
  from: "present",
  destination: "later",
  reason: "target",
  snoozeId: null,
  inactivityCutoffMs: null,
  createdAtMs: now,
};
const policy = {
  version: 1,
  fingerprint: "policy",
  scheduling: {
    idleEnabled: true,
    idleTimeoutMs: 600000,
    idleDestination: 3,
    olderEnabled: true,
    olderTimeoutMs: 86400000,
    graceMs: 300000,
    presentTarget: 7,
  },
};
const base = {
  row,
  operation,
  policy,
  owner: { backendNonce: "owner", generation: 1 },
  nowMs: now,
  idleNotBeforeMs: 0,
  presentCount: 8,
};
type ValidationInput = Parameters<typeof validateOrganizationProposal>[0];
const check = (changes: Partial<ValidationInput> = {}) =>
  validateOrganizationProposal({ ...base, ...changes });

it("accepts the chosen target candidate only while the authoritative global count exceeds target", () => {
  expect(check()).toEqual({ status: "valid" });
  expect(check({ presentCount: 7 })).toEqual({ status: "stale" });
  const withoutTarget: OrganizationSchedulingSettings = { ...policy.scheduling };
  delete withoutTarget.presentTarget;
  expect(check({ policy: { ...policy, scheduling: withoutTarget } })).toEqual({ status: "stale" });
  expect(check({ operation: { ...operation, destination: "done" } })).toEqual({ status: "stale" });
});

it("fences wrong owners, policy versions, revisions, fact versions, sections, IDs and unknown scope", () => {
  for (const changes of [
    { generation: 2 },
    { backendNonce: "other" },
    { policyVersion: 2 },
    { expectedRevision: 1 },
    { factVersion: 2 },
    { from: "later" as const },
    { threadId: "other" },
  ])
    expect(check({ operation: { ...operation, ...changes } })).toEqual({ status: "stale" });
  const withoutScope = { ...row };
  delete withoutScope.inScope;
  expect(check({ row: withoutScope })).toEqual({ status: "stale" });
  expect(check({ row: undefined })).toEqual({ status: "stale" });
});

it("all work, pending attention, unclassified age and snoozes veto cleanup at acceptance", () => {
  const withoutAge = { ...row };
  delete withoutAge.inactivityAtMs;
  expect(check({ row: withoutAge })).toEqual({ status: "stale" });
  for (const changes of [
    { work: 2 },
    { work: 3 },
    { actionable: true },
    { eligible: false },
    { snoozeIdentity: "snooze", snoozeUntilMs: now + 1000 },
  ])
    expect(check({ row: { ...row, ...changes } })).toEqual({ status: "stale" });
});

it("bounded engagement, manual and post-work grace are checked independently of idle settings", () => {
  for (const field of ["manualUntilMs", "graceUntilMs", "engagedUntilMs"] as const) {
    expect(check({ row: { ...row, [field]: now + 5000 } })).toEqual({
      status: "not-due",
      retryNotBeforeMs: now + 5000,
    });
    expect(check({ row: { ...row, [field]: now } })).toEqual({ status: "valid" });
  }
  expect(
    check({
      policy: {
        ...policy,
        scheduling: { ...policy.scheduling, idleEnabled: false, targetNotBeforeMs: now + 5000 },
      },
    }),
  ).toEqual({ status: "not-due", retryNotBeforeMs: now + 5000 });
});

it("idle proof cannot widen cutoffs, shorten the full wait or bypass startup policy barriers", () => {
  const idle = { ...operation, reason: "idle" as const, inactivityCutoffMs: now - 600000 };
  expect(check({ operation: idle })).toEqual({ status: "valid" });
  expect(check({ operation: { ...idle, inactivityCutoffMs: now } })).toEqual({ status: "stale" });
  expect(check({ operation: idle, row: { ...row, inactivityAtMs: now - 599999 } })).toEqual({
    status: "not-due",
    retryNotBeforeMs: now + 1000,
  });
  expect(check({ operation: idle, idleNotBeforeMs: now + 5000 })).toEqual({
    status: "not-due",
    retryNotBeforeMs: now + 5000,
  });
  expect(
    check({
      operation: idle,
      policy: { ...policy, scheduling: { ...policy.scheduling, idleEnabled: false } },
    }),
  ).toEqual({ status: "stale" });
});

it("older Later-to-Done uses its own full age and persisted policy grace, not short startup grace", () => {
  const older = {
    ...operation,
    from: "later" as const,
    reason: "older" as const,
    destination: "done" as const,
    inactivityCutoffMs: now - 86400000,
  };
  expect(
    check({ operation: older, row: { ...row, section: 3 }, idleNotBeforeMs: now + 5000 }),
  ).toEqual({ status: "valid" });
  expect(
    check({
      operation: older,
      row: { ...row, section: 3 },
      policy: { ...policy, olderPolicyChangedAtMs: now - 1000 },
    }),
  ).toEqual({ status: "not-due", retryNotBeforeMs: now - 1000 + 86400000 });
});

it("new actionable requests interrupt manual/snooze but existing requests respect manual moves", () => {
  const attention = {
    ...operation,
    reason: "attention" as const,
    destination: "needs-you" as const,
  };
  const waiting = {
    ...row,
    actionable: true,
    manualUntilMs: now + 5000,
    attentionWatermark: 1,
    manualAttentionWatermark: 1,
  };
  expect(check({ operation: attention, row: waiting })).toEqual({ status: "stale" });
  expect(check({ operation: attention, row: { ...waiting, attentionWatermark: 2 } })).toEqual({
    status: "valid",
  });
  expect(
    check({
      operation: { ...attention, snoozeId: "snooze" },
      row: {
        ...waiting,
        attentionWatermark: 2,
        snoozeIdentity: "snooze",
        snoozeUntilMs: now + 3600000,
      },
    }),
  ).toEqual({ status: "valid" });
  expect(check({ operation: attention, row: { ...waiting, manualUntilMs: now, work: 2 } })).toEqual(
    { status: "valid" },
  );
});

it("silent active work can return any manually moved section only when its override expires", () => {
  for (const [from, section] of [
    ["later", 3],
    ["done", 4],
    ["needs-you", 1],
  ] as const) {
    const active = {
      ...operation,
      from,
      reason: "active" as const,
      destination: "present" as const,
    };
    const working = { ...row, section, work: 2, manualUntilMs: now };
    expect(check({ operation: active, row: working })).toEqual({ status: "valid" });
    expect(check({ operation: active, row: { ...working, manualUntilMs: now + 5000 } })).toEqual({
      status: "not-due",
      retryNotBeforeMs: now + 5000,
    });
    expect(check({ operation: active, row: { ...working, actionable: true } })).toEqual({
      status: "stale",
    });
    expect(check({ operation: active, row: { ...working, work: 3 } })).toEqual({ status: "stale" });
  }
});

it("snooze honours its full deadline, returns Needs you and checks occurrence identity", () => {
  const snoozed = {
    ...row,
    section: 3,
    work: 2,
    snoozeIdentity: "chosen",
    snoozeUntilMs: now + 3600000,
  };
  const expiry = {
    ...operation,
    from: "later" as const,
    reason: "snooze-expired" as const,
    snoozeId: "chosen",
    destination: "needs-you" as const,
  };
  expect(check({ operation: expiry, row: snoozed })).toEqual({
    status: "not-due",
    retryNotBeforeMs: now + 3600000,
  });
  expect(check({ operation: expiry, row: { ...snoozed, snoozeUntilMs: now } })).toEqual({
    status: "valid",
  });
  expect(check({ operation: { ...expiry, snoozeId: "replaced" }, row: snoozed })).toEqual({
    status: "stale",
  });
  expect(
    check({ operation: { ...expiry, reason: "active", destination: "present" }, row: snoozed }),
  ).toEqual({ status: "stale" });
});

it("resolved returns only an answered automatic Needs you placement, whatever the work state", () => {
  const needsYou = { ...row, section: 1, automaticPlacement: true };
  const resolved = { ...operation, from: "needs-you" as const, destination: "present" as const };
  const check = (changes: Partial<OrganizationRow>, op: Partial<OrganizationOperation> = {}) =>
    validateOrganizationProposal({
      ...base,
      row: { ...needsYou, ...changes },
      operation: { ...resolved, reason: "resolved", ...op },
    }).status;
  for (const work of [1, 2, 3]) expect(check({ work })).toBe("valid");
  expect(check({ automaticPlacement: false })).toBe("stale");
  const { automaticPlacement: _, ...legacy } = needsYou;
  expect(
    validateOrganizationProposal({
      ...base,
      row: legacy,
      operation: { ...resolved, reason: "resolved" },
    }).status,
  ).toBe("stale");
  expect(check({ actionable: true, attentionWatermark: 1 })).toBe("stale");
  expect(check({ snoozeIdentity: "snooze", snoozeUntilMs: now - 1 }, { snoozeId: "snooze" })).toBe(
    "stale",
  );
  expect(check({}, { destination: "later" })).toBe("stale");
  expect(check({}, { inactivityCutoffMs: now })).toBe("stale");
  expect(check({ section: 2 }, { from: "present" })).toBe("stale");
  // A live manual override is honoured first (fixed 10-minute expiry, then re-evaluated).
  expect(check({ manualUntilMs: now + 5000 })).toBe("not-due");
});
