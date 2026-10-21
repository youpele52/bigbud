import { Schema } from "effect";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { V2FamilyEvidence } from "./Subagents.extension.ts";

const State = Schema.Struct({
  nativeFamily: Schema.optionalKey(V2FamilyEvidence),
  nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  generation: Schema.Int,
  fenced: Schema.Boolean,
  stopped: Schema.Boolean,
  inputId: Schema.NullOr(Schema.String),
});
/** Exact native acknowledgement is protocol evidence, never physical settlement evidence. */
export function decodeV2NativeFamilyState(value: unknown, owner: V2RuntimeSession, nonce: string) {
  const state = Schema.decodeUnknownSync(State)(value, { onExcessProperty: "error" });
  if (state.nonce !== nonce || state.generation !== owner.family!.generation)
    throw new Error("V2 native family acknowledgement changed owner/generation.");
  return state;
}
