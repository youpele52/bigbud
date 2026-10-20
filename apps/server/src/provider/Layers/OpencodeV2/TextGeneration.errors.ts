import { Schema } from "effect";

/** A paid native request may still exist. This must never become ordinary retryable failure. */
export class V2TextGenerationUncertain extends Schema.TaggedErrorClass<V2TextGenerationUncertain>()(
  "V2TextGenerationUncertain",
  { operation: Schema.String, nativeSessionId: Schema.String },
) {
  override get message(): string {
    return "OpenCode v2 generation dispatch is unconfirmed; native history and capacity retained.";
  }
}
