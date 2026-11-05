// Field numbers mirror protocol/computer-use/*.proto. The schema parity test
// compares every field, type and envelope tag; never reuse a published number.
type Kind = "s" | "u32" | "u64" | "b";
export type Field = readonly [number, Kind, number];
const s = (id: number): Field => [id, "s", 128];
const u = (id: number): Field => [id, "u32", 0];
const q = (id: number): Field => [id, "u64", 0];
const b = (id: number, limit: number): Field => [id, "b", limit];
const digest = (id: number): Field => b(id, 32);
const plan = (id: number): Field => b(id, 48 * 1024);
const data = (id: number): Field => b(id, 25 * 1024 * 1024 - 1024);

export const messageFields = {
  hello: {
    protocol_major: u(1),
    protocol_minor: u(2),
    tuple_digest: s(3),
    role: s(4),
    owner_generation: s(5),
    worker_generation: s(6),
    qualification_profile: s(7),
    control_frame_bytes: u(8),
    data_frame_bytes: u(9),
    instance_id: s(10),
  },
  apply_policy: {
    request_id: s(1),
    authority_id: s(2),
    revision: s(3),
    digest: digest(4),
    canonical_policy: plan(5),
    fence_id: s(6),
  },
  policy_acknowledged: {
    request_id: s(1),
    authority_id: s(2),
    revision: s(3),
    digest: digest(4),
    fence_id: s(5),
  },
  begin_episode: {
    request_id: s(1),
    caller_id: s(2),
    provider_generation: s(3),
    runtime_mode_revision: s(4),
    participation_id: s(5),
  },
  admit_operation: {
    operation_id: s(1),
    request_digest: digest(2),
    caller_id: s(3),
    episode_id: s(4),
    native_session_id: s(5),
    expected_pause_epoch: q(6),
    policy_revision: s(7),
    owner_generation: s(8),
    worker_generation: s(9),
    target_ref: s(10),
    observation_ref: s(11),
    timeout_ms: u(12),
    provider_generation: s(13),
    runtime_mode_revision: s(14),
    caller_sequence: q(15),
    canonical_plan: plan(16),
  },
  admission: { operation_id: s(1), ticket: s(2), native_session_id: s(3) },
  mediated_call: { ticket: s(1), primitive_index: u(2), mcp_frame: data(3) },
  stop: { operation_id: s(1), desktop_scope: s(2) },
  revoked: { operation_id: s(1), pause_epoch: q(2), settlement_id: s(3) },
  resume: {
    request_id: s(1),
    expected_pause_epoch: q(2),
    challenge: s(3),
    authority_id: s(4),
    policy_revision: s(5),
    episode_id: s(6),
  },
  surface_lease: {
    owner_generation: s(1),
    host_identity: s(2),
    document_generation: s(3),
    challenge: s(4),
    interactive_desktop_identity: s(5),
    qualification_id: s(6),
  },
  warning_presented: {
    episode_id: s(1),
    notice_id: s(2),
    document_generation: s(3),
    challenge: s(4),
  },
  status: {
    request_id: s(1),
    state: s(2),
    pause_epoch: q(3),
    applied_revision: s(4),
    episode_id: s(5),
    notice_id: s(6),
    notice_state: s(7),
    retirement: s(8),
    input_state: s(9),
    queued_operations: u(10),
  },
  operation_result: {
    operation_id: s(1),
    completion: s(2),
    code: s(3),
    projected_result: data(4),
    capture_error: s(5),
  },
  lookup_operation: { caller_id: s(1), operation_id: s(2), request_digest: digest(3) },
  revoke_caller: { caller_id: s(1), provider_generation: s(2), runtime_mode_revision: s(3) },
  settlement: { settlement_id: s(1), retirement: s(2), input_state: s(3) },
  protocol_error: { request_id: s(1), code: s(2) },
} as const;

export const envelopeTags = {
  hello: 1,
  apply_policy: 2,
  policy_acknowledged: 3,
  begin_episode: 4,
  admit_operation: 5,
  admission: 6,
  mediated_call: 7,
  stop: 8,
  revoked: 9,
  resume: 10,
  surface_lease: 11,
  warning_presented: 12,
  status: 13,
  operation_result: 14,
  lookup_operation: 15,
  revoke_caller: 16,
  settlement: 17,
  protocol_error: 18,
} as const;

export type MessageKind = keyof typeof messageFields;
export type WireValue = string | number | Uint8Array;
export type WireRecord = Record<string, WireValue>;
export interface ComputerUseFrame {
  readonly kind: MessageKind;
  readonly value: WireRecord;
}
