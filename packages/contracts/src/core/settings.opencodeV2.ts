import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas";

/** Shared TUI service is the default; private storage requires explicit opt-in. */
export const OpencodeV2DevelopmentSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  profileRoot: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  connectionMode: Schema.optionalKey(Schema.Literals(["shared", "isolated"])),
  serviceFile: Schema.optionalKey(TrimmedString),
  nativeServiceTrust: Schema.optionalKey(Schema.NullOr(Schema.Literal("host-user-v1"))),
});
export type OpencodeV2DevelopmentSettings = typeof OpencodeV2DevelopmentSettings.Type;
