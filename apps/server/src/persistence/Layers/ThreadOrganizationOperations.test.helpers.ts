import type { ThreadOrganizationNativeOperation as OrganizationOperation } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";

export const operation: OrganizationOperation = {
  operationId: "operation",
  occurrenceId: "occurrence",
  attempt: 0,
  threadId: "thread",
  backendNonce: "backend",
  generation: 1,
  policyVersion: 1,
  factVersion: 1,
  expectedRevision: 1,
  from: "present",
  destination: "later",
  reason: "target",
  snoozeId: null,
  inactivityCutoffMs: null,
  createdAtMs: 1000,
};
