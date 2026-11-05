import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedString } from "./baseSchemas";

const MuseBinaryPath = TrimmedString.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value || "muse"),
      encode: (value) => Effect.succeed(value),
    }),
  ),
  Schema.withDecodingDefault(() => "muse"),
);

/**
 * Muse Code settings. bigbud never stores Muse credentials, native
 * account state, or arbitrary CLI arguments; sign-in stays in the native
 * `muse` terminal flow and native settings remain authoritative.
 */
export const MuseSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  binaryPath: MuseBinaryPath,
});
export type MuseSettings = typeof MuseSettings.Type;
