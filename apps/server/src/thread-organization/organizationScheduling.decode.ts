import { fields, uint, optionalUint, bytes, text } from "./organizationProtocol.wire.ts";
import type {
  OrganizationSchedulingSettings,
  OrganizationReceipt,
  OrganizationProposal,
  OrganizationNativeFrame,
} from "./organizationProtocol.ts";
import { ORGANIZATION_MAX_FRAME_BYTES } from "./organizationProtocol.ts";

export function decodeSchedulingSettings(input: Uint8Array): OrganizationSchedulingSettings {
  const v = fields(input, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 });
  return {
    idleEnabled: uint(v, 1) !== 0,
    idleTimeoutMs: uint(v, 2),
    idleDestination: uint(v, 3),
    olderEnabled: uint(v, 4) !== 0,
    olderTimeoutMs: uint(v, 5),
    graceMs: uint(v, 8),
    ...(v.has(6) ? { presentTarget: uint(v, 6) } : {}),
    ...(v.has(7) ? { targetNotBeforeMs: uint(v, 7) } : {}),
  };
}
export function decodeSchedulingReceipt(input: Uint8Array): OrganizationReceipt {
  const v = fields(input, { 1: 2, 2: 0, 3: 0, 4: 0, 5: 0 });
  return {
    operationId: text(v, 1),
    outcome: uint(v, 2),
    resultRevision: uint(v, 4),
    resultSequence: uint(v, 5),
    ...(v.has(3) ? { retryNotBeforeMs: uint(v, 3) } : {}),
  };
}
function proposal(input: Uint8Array): OrganizationProposal {
  const v = fields(input, {
    1: 2,
    2: 2,
    3: 0,
    4: 2,
    5: 0,
    6: 0,
    7: 0,
    8: 0,
    9: 0,
    10: 0,
    11: 2,
    12: 0,
    13: 0,
  });
  return {
    operationId: text(v, 1),
    occurrenceId: text(v, 2),
    attempt: uint(v, 3),
    threadId: text(v, 4),
    factVersion: uint(v, 5),
    expectedRevision: uint(v, 6),
    policyVersion: uint(v, 7),
    from: uint(v, 8),
    destination: uint(v, 9),
    reason: uint(v, 10),
    snoozeIdentity: text(v, 11),
    ...(optionalUint(v, 12) !== undefined ? { inactivityCutoffMs: uint(v, 12) } : {}),
    createdAtMs: uint(v, 13),
  };
}
export function decodeOrganizationNativeFrame(input: Uint8Array): OrganizationNativeFrame {
  if (input.length === 0 || input.length > ORGANIZATION_MAX_FRAME_BYTES)
    throw new Error("invalid native organisation frame size");
  const v = fields(input, { 1: 2, 2: 0, 3: 2, 4: 2, 5: 2 });
  const kinds = [3, 4, 5].filter((field) => v.has(field));
  if (kinds.length !== 1) throw new Error("native organisation frame needs one payload");
  const base = { backendNonce: text(v, 1), generation: uint(v, 2) };
  if (kinds[0] === 4) return { ...base, type: "proposal", value: proposal(bytes(v, 4)) };
  const payload = fields(bytes(v, kinds[0]!), { 1: 0, 2: 0 });
  return kinds[0] === 3
    ? { ...base, type: "ready", sequence: uint(payload, 1), policyVersion: uint(payload, 2) }
    : { ...base, type: "heartbeat", sequence: uint(payload, 1) };
}
