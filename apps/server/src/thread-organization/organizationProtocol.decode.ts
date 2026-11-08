import { fields, uint, optionalUint, bytes, text } from "./organizationProtocol.wire.ts";
import {
  decodeSchedulingSettings,
  decodeSchedulingReceipt,
} from "./organizationScheduling.decode.ts";
import {
  ORGANIZATION_MAX_FRAME_BYTES,
  type OrganizationFrame,
  type OrganizationRow,
  type OrganizationPayload,
  type OrganizationLimits,
  type OrganizationPolicy,
} from "./organizationProtocol.ts";

function decodeRow(encoded: Uint8Array): OrganizationRow {
  const v = fields(encoded, {
    1: 2,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
    8: 0,
    9: 0,
    10: 0,
    11: 2,
    12: 0,
    13: 0,
    14: 0,
    15: 0,
    16: 0,
    17: 0,
  });
  return {
    threadId: text(v, 1),
    factVersion: uint(v, 2),
    organizationRevision: uint(v, 3),
    section: uint(v, 4),
    work: uint(v, 5),
    actionable: uint(v, 6) !== 0,
    attentionWatermark: uint(v, 7),
    ...(v.has(8) ? { inactivityAtMs: uint(v, 8) } : {}),
    ...(v.has(9) ? { manualUntilMs: uint(v, 9) } : {}),
    ...(v.has(10) ? { snoozeUntilMs: uint(v, 10) } : {}),
    snoozeIdentity: text(v, 11),
    ...(v.has(12) ? { graceUntilMs: uint(v, 12) } : {}),
    eligible: uint(v, 13) !== 0,
    ...(v.has(14) ? { inScope: uint(v, 14) !== 0 } : {}),
    ...(v.has(15) ? { manualAttentionWatermark: uint(v, 15) } : {}),
    ...(v.has(16) ? { engagedUntilMs: uint(v, 16) } : {}),
    ...(v.has(17) ? { automaticPlacement: uint(v, 17) !== 0 } : {}),
  };
}
function decodePolicy(encoded: Uint8Array): OrganizationPolicy {
  const p = fields(encoded, { 1: 0, 2: 2, 3: 0, 4: 2 });
  const older = optionalUint(p, 3);
  return {
    version: uint(p, 1),
    fingerprint: text(p, 2),
    ...(older !== undefined ? { olderPolicyChangedAtMs: older } : {}),
    ...(p.has(4) ? { scheduling: decodeSchedulingSettings(bytes(p, 4)) } : {}),
  };
}
function decodeLimits(encoded: Uint8Array): OrganizationLimits {
  const v = fields(encoded, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 });
  return {
    frameBytes: uint(v, 1),
    pageRows: uint(v, 2),
    liveRows: uint(v, 3),
    stateBytes: uint(v, 4),
    pendingFacts: uint(v, 5),
    pendingBytes: uint(v, 6),
  };
}
function decodePayload(field: number, encoded: Uint8Array): OrganizationPayload {
  if (field === 3) {
    const v = fields(encoded, { 1: 0, 2: 0, 3: 2, 4: 2 });
    return {
      type: "hello",
      value: {
        major: uint(v, 1),
        minor: uint(v, 2),
        capability: text(v, 3),
        limits: decodeLimits(bytes(v, 4)),
      },
    };
  }
  if (field === 4) {
    const v = fields(encoded, { 1: 2, 2: 0, 3: 0, 4: 2 });
    return {
      type: "begin",
      value: {
        snapshotId: text(v, 1),
        sequence: uint(v, 2),
        sourceFrontier: uint(v, 3),
        policy: decodePolicy(bytes(v, 4)),
      },
    };
  }
  if (field === 5) {
    const v = fields(encoded, { 1: 2, 2: 0, 3: 2 });
    const rows = (v.get(3) ?? []).map((row) => {
      if (typeof row === "number") throw new Error("invalid organisation row");
      return decodeRow(row);
    });
    return { type: "page", value: { snapshotId: text(v, 1), index: uint(v, 2), rows } };
  }
  if (field === 6) {
    const v = fields(encoded, { 1: 2, 2: 0, 3: 0, 4: 2, 5: 0 });
    return {
      type: "end",
      value: {
        snapshotId: text(v, 1),
        pages: uint(v, 2),
        rows: uint(v, 3),
        digest: bytes(v, 4),
        policyVersion: uint(v, 5),
      },
    };
  }
  if (field === 9)
    return { type: "heartbeat", value: { sequence: uint(fields(encoded, { 1: 0 }), 1) } };
  if (field === 8) return { type: "receipt", value: decodeSchedulingReceipt(encoded) };
  if (field === 10) return { type: "policy", value: decodePolicy(encoded) };
  const v = fields(encoded, { 1: 0, 2: 0, 3: 2, 4: 0 });
  return {
    type: "fact",
    value: {
      sequence: uint(v, 1),
      sourceFrontier: uint(v, 2),
      row: decodeRow(bytes(v, 3)),
      deleted: uint(v, 4) !== 0,
    },
  };
}
export function decodeOrganizationFrame(encoded: Uint8Array): OrganizationFrame {
  if (encoded.length === 0 || encoded.length > ORGANIZATION_MAX_FRAME_BYTES)
    throw new Error("invalid organisation frame length");
  const v = fields(encoded, { 1: 2, 2: 0, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 2 });
  const payloads = [3, 4, 5, 6, 7, 8, 9, 10].filter((field) => v.has(field));
  const field = payloads[0];
  if (payloads.length !== 1 || field === undefined)
    throw new Error("organisation frame needs one payload");
  return {
    backendNonce: text(v, 1),
    generation: uint(v, 2),
    ...decodePayload(field, bytes(v, field)),
  };
}
export function decodeOrganizationDelimitedFrame(encoded: Uint8Array): OrganizationFrame {
  if (encoded.length < 4) throw new Error("truncated organisation prefix");
  const length = new DataView(encoded.buffer, encoded.byteOffset, 4).getUint32(0, false);
  if (length === 0 || length > ORGANIZATION_MAX_FRAME_BYTES || length !== encoded.length - 4)
    throw new Error("invalid organisation prefix");
  return decodeOrganizationFrame(encoded.subarray(4));
}
