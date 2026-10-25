import type { SessionInfo } from "@opencode/client";
import { Schema } from "effect";

const Bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const NumberValue = Schema.Number.check(Schema.isFinite());
const OptionalNumber = Schema.optionalKey(NumberValue);
const Session = Schema.Struct({
  id: Bounded,
  projectID: Bounded,
  parentID: Schema.optionalKey(Bounded),
  agent: Schema.optionalKey(Bounded),
  model: Schema.optionalKey(
    Schema.Struct({ id: Bounded, providerID: Bounded, variant: Schema.optionalKey(Bounded) }),
  ),
  location: Schema.Struct({ directory: Bounded }),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  permissions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        action: Bounded,
        resource: Bounded,
        effect: Schema.Literals(["allow", "ask", "deny"]),
      }),
    ).check(Schema.isMaxLength(1000)),
  ),
  cost: NumberValue,
  tokens: Schema.Struct({
    input: NumberValue,
    output: NumberValue,
    reasoning: NumberValue,
    cache: Schema.Struct({ read: NumberValue, write: NumberValue }),
  }),
  time: Schema.Struct({
    created: NumberValue,
    updated: NumberValue,
    idle: OptionalNumber,
    viewed: OptionalNumber,
    archived: OptionalNumber,
  }),
  outcome: Schema.optionalKey(Schema.Literals(["succeeded", "failed", "interrupted"])),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120000))),
  subpath: Schema.optionalKey(Bounded),
  fork: Schema.optionalKey(
    Schema.Struct({
      sessionID: Bounded,
      boundary: Schema.Struct({ type: Schema.Literals(["before", "through"]), messageID: Bounded }),
    }),
  ),
  revert: Schema.optionalKey(
    Schema.Struct({
      messageID: Bounded,
      partID: Schema.optionalKey(Bounded),
      snapshot: Schema.optionalKey(Bounded),
      files: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            file: Bounded,
            patch: Schema.String,
            additions: NumberValue,
            deletions: NumberValue,
            status: Schema.Literals(["added", "deleted", "modified"]),
          }),
        ).check(Schema.isMaxLength(1000)),
      ),
    }),
  ),
});
const decode = Schema.decodeUnknownSync(Session);

/** Successful HTTP is existence, never absence; invalid SDK-unwrapped bodies are uncertainty. */
export function decodeV2NativeSession(value: unknown): SessionInfo {
  try {
    decode(value);
    return value as SessionInfo;
  } catch {
    throw new Error(
      "V2 session lookup unconfirmed: invalid successful native session projection; no replacement.",
    );
  }
}
