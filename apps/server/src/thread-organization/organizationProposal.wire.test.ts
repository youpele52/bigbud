import { expect, it } from "vitest";
import {
  organizationOperationFromProposal,
  organizationReceiptForOutcome,
} from "./organizationProposal.wire.ts";
import type { OrganizationProposal } from "./organizationProtocol.ts";
const owner = { backendNonce: "owner", generation: 1 };
const proposal: OrganizationProposal = {
  operationId: "op",
  occurrenceId: "occurrence",
  attempt: 0,
  threadId: "thread",
  factVersion: 1,
  expectedRevision: 2,
  policyVersion: 3,
  from: 2,
  destination: 3,
  reason: 6,
  snoozeIdentity: "",
  createdAtMs: 1000,
};

it("maps only explicit wire enums and schema-valid identities into immutable operations", () => {
  expect(organizationOperationFromProposal(owner, proposal)).toEqual({
    operationId: "op",
    occurrenceId: "occurrence",
    attempt: 0,
    threadId: "thread",
    ...owner,
    factVersion: 1,
    expectedRevision: 2,
    policyVersion: 3,
    from: "present",
    destination: "later",
    reason: "target",
    snoozeId: null,
    inactivityCutoffMs: null,
    createdAtMs: 1000,
  });
  for (const field of ["from", "destination", "reason"] as const)
    for (const value of [-1, 0, 1.1, 100, NaN])
      expect(() =>
        organizationOperationFromProposal(owner, { ...proposal, [field]: value }),
      ).toThrow();
  for (const changes of [
    { operationId: "" },
    { occurrenceId: "x".repeat(257) },
    { attempt: -1 },
    { factVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(() => organizationOperationFromProposal(owner, { ...proposal, ...changes })).toThrow();
});

it("preserves snooze identity, exact immutable timestamp and optional-zero cutoffs", () => {
  expect(
    organizationOperationFromProposal(owner, {
      ...proposal,
      snoozeIdentity: "chosen",
      inactivityCutoffMs: 0,
    }),
  ).toMatchObject({ snoozeId: "chosen", inactivityCutoffMs: 0, createdAtMs: 1000 });
});

it("maps durable outcomes to typed native receipts without inventing results for no-ops", () => {
  expect(
    organizationReceiptForOutcome("op", {
      status: "applied",
      resultRevision: 3,
      resultSequence: 4,
    }),
  ).toEqual({ operationId: "op", outcome: 1, resultRevision: 3, resultSequence: 4 });
  expect(organizationReceiptForOutcome("op", { status: "stale" })).toEqual({
    operationId: "op",
    outcome: 2,
    resultRevision: 0,
    resultSequence: 0,
  });
  expect(
    organizationReceiptForOutcome("op", { status: "not-due", retryNotBeforeMs: 5000 }),
  ).toEqual({
    operationId: "op",
    outcome: 3,
    resultRevision: 0,
    resultSequence: 0,
    retryNotBeforeMs: 5000,
  });
});

it("maps the resolved reason (wire 7) into the automatic return contract", () => {
  expect(
    organizationOperationFromProposal(owner, { ...proposal, from: 1, destination: 2, reason: 7 }),
  ).toMatchObject({ from: "needs-you", destination: "present", reason: "resolved" });
  expect(() => organizationOperationFromProposal(owner, { ...proposal, reason: 8 })).toThrow();
});
