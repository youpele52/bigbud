import * as Schema from "effect/Schema";

export const TerminalWslIdentity = Schema.Struct({
  distribution: Schema.String,
  username: Schema.String,
  uid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type TerminalWslIdentity = typeof TerminalWslIdentity.Type;

export const TerminalWslDistributions = Schema.Struct({
  supported: Schema.Boolean,
  distributions: Schema.Array(Schema.String),
});
export type TerminalWslDistributions = typeof TerminalWslDistributions.Type;

export class TerminalWslDiscoveryError extends Schema.TaggedErrorClass<TerminalWslDiscoveryError>()(
  "TerminalWslDiscoveryError",
  { message: Schema.String },
) {}
