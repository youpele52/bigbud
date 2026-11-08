import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { organizationDelimitedFrame } from "./organizationNative.framing.ts";
import {
  ORGANIZATION_LIMITS,
  type OrganizationFrame,
  type OrganizationLimits,
  type OrganizationPolicy,
  type OrganizationRow,
  type OrganizationFact,
} from "./organizationProtocol.ts";

import { validateOrganizationLimits } from "./organizationProtocol.limits.ts";
import {
  encodeSchedulingSettings,
  encodeSchedulingReceipt,
} from "./organizationScheduling.encode.ts";

import { optionalUint } from "./organizationProtocol.wireWrite.ts";
export function encodeOrganizationRow(row: OrganizationRow): Uint8Array {
  const w = new WireWriter();
  w.fieldString(1, row.threadId);
  w.fieldUint(2, row.factVersion);
  w.fieldUint(3, row.organizationRevision);
  w.fieldUint(4, row.section);
  w.fieldUint(5, row.work);
  w.fieldBool(6, row.actionable);
  w.fieldUint(7, row.attentionWatermark);
  optionalUint(w, 8, row.inactivityAtMs);
  optionalUint(w, 9, row.manualUntilMs);
  optionalUint(w, 10, row.snoozeUntilMs);
  w.fieldString(11, row.snoozeIdentity);
  optionalUint(w, 12, row.graceUntilMs);
  w.fieldBool(13, row.eligible);
  optionalUint(w, 14, row.inScope === undefined ? undefined : row.inScope ? 1 : 0);
  optionalUint(w, 15, row.manualAttentionWatermark);
  optionalUint(w, 16, row.engagedUntilMs);
  optionalUint(
    w,
    17,
    row.automaticPlacement === undefined ? undefined : row.automaticPlacement ? 1 : 0,
  );
  return w.finish();
}
function encodeLimits(limits: OrganizationLimits): Uint8Array {
  const w = new WireWriter();
  [
    limits.frameBytes,
    limits.pageRows,
    limits.liveRows,
    limits.stateBytes,
    limits.pendingFacts,
    limits.pendingBytes,
  ].forEach((value, index) => w.fieldUint(index + 1, value));
  return w.finish();
}
function encodePolicy(policy: OrganizationPolicy): Uint8Array {
  const w = new WireWriter();
  w.fieldUint(1, policy.version);
  w.fieldString(2, policy.fingerprint);
  optionalUint(w, 3, policy.olderPolicyChangedAtMs);
  if (policy.scheduling) w.fieldMessage(4, encodeSchedulingSettings(policy.scheduling));
  return w.finish();
}
export function encodeOrganizationFact(fact: OrganizationFact): Uint8Array {
  const w = new WireWriter();
  w.fieldUint(1, fact.sequence);
  w.fieldUint(2, fact.sourceFrontier);
  w.fieldMessage(3, encodeOrganizationRow(fact.row));
  w.fieldBool(4, fact.deleted);
  return w.finish();
}
export function encodeOrganizationFrame(
  frame: OrganizationFrame,
  limits: OrganizationLimits = ORGANIZATION_LIMITS,
): Uint8Array {
  validateOrganizationLimits(limits);
  const w = new WireWriter();
  w.fieldString(1, frame.backendNonce);
  w.fieldUint(2, frame.generation);
  const body = new WireWriter();
  let field: number;
  switch (frame.type) {
    case "hello":
      field = 3;
      body.fieldUint(1, frame.value.major);
      body.fieldUint(2, frame.value.minor);
      body.fieldString(3, frame.value.capability);
      body.fieldMessage(4, encodeLimits(frame.value.limits));
      break;
    case "begin":
      field = 4;
      body.fieldString(1, frame.value.snapshotId);
      body.fieldUint(2, frame.value.sequence);
      body.fieldUint(3, frame.value.sourceFrontier);
      body.fieldMessage(4, encodePolicy(frame.value.policy));
      break;
    case "page":
      field = 5;
      body.fieldString(1, frame.value.snapshotId);
      body.fieldUint(2, frame.value.index);
      for (const row of frame.value.rows) body.fieldMessage(3, encodeOrganizationRow(row));
      break;
    case "end":
      field = 6;
      body.fieldString(1, frame.value.snapshotId);
      body.fieldUint(2, frame.value.pages);
      body.fieldUint(3, frame.value.rows);
      body.fieldBytes(4, frame.value.digest);
      body.fieldUint(5, frame.value.policyVersion);
      break;
    case "heartbeat":
      field = 9;
      body.fieldUint(1, frame.value.sequence);
      break;
    case "receipt":
      field = 8;
      for (const byte of encodeSchedulingReceipt(frame.value)) body.bytes.push(byte);
      break;
    case "fact":
      field = 7;
      for (const byte of encodeOrganizationFact(frame.value)) body.bytes.push(byte);
      break;
    case "policy":
      field = 10;
      for (const byte of encodePolicy(frame.value)) body.bytes.push(byte);
      break;
  }
  const payload = body.finish();
  // A oneof with an empty protobuf message still has presence (heartbeat sequence0).
  if (payload.length === 0) w.bytes.push(field * 8 + 2, 0);
  else w.fieldMessage(field, payload);
  const bytes = w.finish();
  if (bytes.length > limits.frameBytes) throw new RangeError("organisation frame exceeds limit");
  return bytes;
}

export function encodeOrganizationDelimitedFrame(
  frame: OrganizationFrame,
  limits: OrganizationLimits = ORGANIZATION_LIMITS,
): Uint8Array {
  const payload = encodeOrganizationFrame(frame, limits);
  return organizationDelimitedFrame(payload);
}
