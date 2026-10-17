import { Schema } from "effect";
import { V2_THREAD_ACTIONS } from "./Orchestration.protocol.ts";
import { V2_THREAD_HANDLER_V1 } from "./Orchestration.implementation.v1.ts";
import {
  v2ImmutableJson,
  validateV2PreparedBody,
} from "./Orchestration.implementation.boundary.ts";
import type { V2PureJson } from "./Orchestration.implementation.types.ts";

const Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Nonce = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Base = {
  ownerDigest: Hex,
  enrollmentNonce: Nonce,
  requestNonce: Nonce,
  leaseRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  leaseExpiresAt: Schema.Int,
};
const Callback = Schema.Union([
  Schema.Struct({
    ...Base,
    kind: Schema.Literal("proof"),
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    expiry: Schema.Int,
    challenge: Nonce,
  }),
  Schema.Struct({ ...Base, kind: Schema.Literal("status") }),
  Schema.Struct({
    ...Base,
    kind: Schema.Literal("invoke"),
    sessionID: Id,
    messageID: Id,
    callID: Id,
    agent: Id,
    action: Schema.Literals(V2_THREAD_ACTIONS),
    input: Schema.Record(Schema.String, Schema.Unknown),
  }),
]);

/** Fatal UTF-8/body bounds belong to transport; every identity field is decoded without excess properties. */
export const decodeV2ThreadCallback = (value: unknown) =>
  Schema.decodeUnknownSync(Callback)(value, { onExcessProperty: "error" });
export type V2ThreadInvocation = Extract<typeof Callback.Type, { kind: "invoke" }>;

/** Compatibility helper only; broker owners capture their version before any preparation. */
export function canonicalV2ThreadRequest(invocation: V2ThreadInvocation, callerThreadId: string) {
  return validateV2PreparedBody(
    invocation.action,
    V2_THREAD_HANDLER_V1.prepare({
      action: invocation.action,
      input: v2ImmutableJson(invocation.input) as Readonly<Record<string, V2PureJson>>,
      callerThreadId,
    }),
    callerThreadId,
  );
}
