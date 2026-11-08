// Compact derived facts and frames. TS owns facts/DB; Rust alone schedules.
import { ORGANIZATION_THREAD_LIMIT } from "@bigbud/contracts/constants/organization.constant.ts";

export const ORGANIZATION_MAX_FRAME_BYTES = 1_048_576;
export const ORGANIZATION_LIMITS = {
  frameBytes: ORGANIZATION_MAX_FRAME_BYTES,
  pageRows: 256,
  liveRows: ORGANIZATION_THREAD_LIMIT,
  stateBytes: 64 * 1024 * 1024,
  pendingFacts: 2_000,
  pendingBytes: 8 * 1024 * 1024,
} as const;

export interface OrganizationLimits {
  frameBytes: number;
  pageRows: number;
  liveRows: number;
  stateBytes: number;
  pendingFacts: number;
  pendingBytes: number;
}
export interface OrganizationSchedulingSettings {
  idleEnabled: boolean;
  idleTimeoutMs: number;
  idleDestination: number;
  olderEnabled: boolean;
  olderTimeoutMs: number;
  presentTarget?: number;
  targetNotBeforeMs?: number;
  graceMs: number;
}
export interface OrganizationReceipt {
  operationId: string;
  outcome: number;
  retryNotBeforeMs?: number;
  resultRevision: number;
  resultSequence: number;
}
export interface OrganizationProposal {
  operationId: string;
  occurrenceId: string;
  attempt: number;
  threadId: string;
  factVersion: number;
  expectedRevision: number;
  policyVersion: number;
  from: number;
  destination: number;
  reason: number;
  snoozeIdentity: string;
  inactivityCutoffMs?: number;
  createdAtMs: number;
}
export type OrganizationNativeFrame = { backendNonce: string; generation: number } & (
  | { type: "ready"; sequence: number; policyVersion: number }
  | { type: "proposal"; value: OrganizationProposal }
  | { type: "heartbeat"; sequence: number }
);
export interface OrganizationPolicy {
  version: number;
  fingerprint: string;
  olderPolicyChangedAtMs?: number;
  scheduling?: OrganizationSchedulingSettings;
}
export interface OrganizationRow {
  threadId: string;
  factVersion: number;
  organizationRevision: number;
  section: number; // 1 Needs you, 2 Present, 3 Later, 4 Done
  work: number; // 1 idle, 2 active, 3 unknown (protect cleanup, not known activity)
  actionable: boolean;
  attentionWatermark: number;
  inactivityAtMs?: number;
  manualUntilMs?: number;
  snoozeUntilMs?: number;
  snoozeIdentity: string;
  graceUntilMs?: number;
  eligible: boolean;
  inScope?: boolean;
  manualAttentionWatermark?: number;
  engagedUntilMs?: number;
  /** Current Needs you placement was made by automation (cleared by any deliberate move). */
  automaticPlacement?: boolean;
}
export interface OrganizationFact {
  sequence: number;
  sourceFrontier: number;
  row: OrganizationRow;
  deleted: boolean;
}
export interface SnapshotBegin {
  snapshotId: string;
  sequence: number;
  sourceFrontier: number;
  policy: OrganizationPolicy;
}
export interface SnapshotPage {
  snapshotId: string;
  index: number;
  rows: OrganizationRow[];
}
export interface SnapshotEnd {
  snapshotId: string;
  pages: number;
  rows: number;
  digest: Uint8Array;
  policyVersion: number;
}
export type OrganizationPayload =
  | {
      type: "hello";
      value: { major: number; minor: number; capability: string; limits: OrganizationLimits };
    }
  | { type: "begin"; value: SnapshotBegin }
  | { type: "page"; value: SnapshotPage }
  | { type: "end"; value: SnapshotEnd }
  | { type: "fact"; value: OrganizationFact }
  | { type: "receipt"; value: OrganizationReceipt }
  | { type: "heartbeat"; value: { sequence: number } }
  /** In-place policy/barrier update after activation; never a fact or scheduling decision. */
  | { type: "policy"; value: OrganizationPolicy };
export type OrganizationFrame = OrganizationPayload & { backendNonce: string; generation: number };
