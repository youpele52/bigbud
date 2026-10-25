import * as Schema from "effect/Schema";

const fingerprint = Schema.String;
const result = Schema.Struct({ content: Schema.String });
const metadata = {
  format: Schema.Literal("bigbud.thread.receipt.v2"),
  implementationDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  requestDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  resultEncoding: Schema.Literal("bigbud.thread.final-json.v1"),
};
const Receipt = Schema.Union([
  Schema.Struct({ fingerprint, state: Schema.Literal("reserved") }),
  Schema.Struct({ fingerprint, state: Schema.Literal("completed"), result }),
  Schema.Struct({ fingerprint, state: Schema.Literal("reserved"), ...metadata }),
  Schema.Struct({ fingerprint, state: Schema.Literal("completed"), result, ...metadata }),
]);
/** Historical final results are identity-interpreted evidence, never rewritten or upgraded by inference. */
export function decodeV2ThreadReceipt(value: unknown) {
  try {
    return Schema.decodeUnknownSync(Receipt)(value, { onExcessProperty: "error" });
  } catch {
    throw new Error("V2 receipt encoding/evidence is invalid; retained without reinterpretation.");
  }
}
