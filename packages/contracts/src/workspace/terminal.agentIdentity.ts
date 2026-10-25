import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "../core/baseSchemas";

/** Foreground terminal agent identity, independent of supported native chat providers. */
export const TerminalAgentIdentity = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  names: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
});
export type TerminalAgentIdentity = typeof TerminalAgentIdentity.Type;
