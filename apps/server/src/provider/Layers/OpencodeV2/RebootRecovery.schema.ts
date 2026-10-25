import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";

const Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Host = Schema.Struct({
  host: Hex,
  bootSession: Schema.String.check(
    Schema.isPattern(/^(?:[a-f0-9-]{36}|windows-kernel:(?:0|[1-9]\d{0,9}))$/),
  ),
  bootSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  bootMicroseconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1000000)),
});
const Signed = Schema.Struct({
  revision: Schema.String,
  value: Schema.Unknown,
  signature: Schema.String,
});
const Entry = Schema.Struct({ name: Hex, signed: Signed });
const BoundedEntries = Schema.Array(Entry).check(Schema.isMaxLength(64));
export const V2RebootCheckpoint = Schema.Struct({
  format: Schema.Literal("bigbud.thread.reboot-checkpoint.v1"),
  purpose: Schema.Literal("physical-retirement-only-no-replay"),
  stateRoot: Schema.String,
  issuer: Hex,
  preparedAt: Schema.String,
  host: Host,
  backup: Schema.Struct({ directory: Schema.String, databaseDigest: Hex }),
  owners: BoundedEntries.check(Schema.isMinLength(1)),
  receipts: BoundedEntries,
  journal: Schema.Array(Schema.Struct({ threadId: Schema.String, digest: Hex })).check(
    Schema.isMaxLength(64),
  ),
});
export type V2RebootCheckpoint = typeof V2RebootCheckpoint.Type;
export const V2RebootSettlement = Schema.Struct({
  format: Schema.Literal("bigbud.thread.reboot-settlement.v1"),
  checkpointDigest: Hex,
  host: Host,
  settledAt: Schema.String,
  physicalEvidence: Schema.Literal("verified-host-reboot"),
  receiptOutcome: Schema.Literal("unknown-preserved-no-replay"),
});
export type V2RebootSettlement = typeof V2RebootSettlement.Type;
export const checkpointKey = "reboot-checkpoint-v1";
export const settlementKey = "reboot-settlement-v1";
export const recoveryDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const decodeCheckpoint = (value: unknown) =>
  Schema.decodeUnknownSync(V2RebootCheckpoint)(value, { onExcessProperty: "error" });
export const decodeSettlement = (value: unknown) =>
  Schema.decodeUnknownSync(V2RebootSettlement)(value, { onExcessProperty: "error" });
