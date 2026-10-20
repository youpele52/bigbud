import { Schema } from "effect";
const Bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const V2Cursor = Schema.Struct({
  provider: Schema.Literal("opencodeV2"),
  nativeSessionId: Bounded,
  storageIdentity: Bounded,
  directory: Bounded,
  connectionMode: Schema.optionalKey(Schema.Literals(["shared", "isolated"])),
  identityVersion: Schema.optionalKey(Schema.Literals([1, 2])),
  profileIssuer: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  registrationFamily: Schema.optionalKey(Schema.Literals(["legacy", "scoped"])),
  model: Schema.optionalKey(
    Schema.Struct({ providerID: Bounded, id: Bounded, variant: Schema.optionalKey(Bounded) }),
  ),
});
export const decodeV2Cursor = Schema.decodeUnknownSync(V2Cursor);
