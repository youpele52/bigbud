import * as Schema from "effect/Schema";
import type { MobileRemoteSessionRecord } from "../Services/MobileRemoteControl.ts";

const PairingRecord = Schema.Struct({
  pairingId: Schema.String,
  secret: Schema.String,
  scope: Schema.Literals(["read-only", "approve-only", "thread-control"] as const),
  baseUrl: Schema.String,
  backendBaseUrl: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  exchangedAt: Schema.NullOr(Schema.String),
  remoteAdmission: Schema.optional(Schema.Unknown),
});
export type PairingRecord = typeof PairingRecord.Type;

const SessionRecord = Schema.Struct({
  sessionId: Schema.String,
  token: Schema.String,
  scope: Schema.Literals(["read-only", "approve-only", "thread-control"] as const),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  label: Schema.String,
  remoteAdmission: Schema.optional(Schema.Unknown),
});
export type SessionRecord = typeof SessionRecord.Type;

export const decodePairingRecord = Schema.decodeUnknownSync(PairingRecord);
export const decodeSessionRecord = Schema.decodeUnknownSync(SessionRecord);

export function toSessionRecord(record: SessionRecord): MobileRemoteSessionRecord {
  return {
    sessionId: record.sessionId,
    token: record.token,
    scope: record.scope,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
    label: record.label,
  };
}
