import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas";

/** Dormant configuration boundary; no shared V1 path or secret is accepted. */
export const OpencodeV2DevelopmentSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  binaryPath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  profileRoot: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
});
export type OpencodeV2DevelopmentSettings = typeof OpencodeV2DevelopmentSettings.Type;
