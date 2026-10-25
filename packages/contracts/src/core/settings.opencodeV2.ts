import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas";

/** Older acknowledgement remains decodable but grants no managed-plugin file-write authority. */
export const OpencodeV2NativeServiceTrust = Schema.NullOr(
  Schema.Literals(["host-user-v1", "managed-thread-tools-v2"]),
);
export const OpencodeV2PluginConfigRoot = TrimmedString.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^(?:$|\/|[a-zA-Z]:[\\/]|\\\\)/),
  // oxlint-disable-next-line no-control-regex -- NUL is rejected deliberately in filesystem paths.
  Schema.isPattern(/^[^\0]*$/),
);

/** Shared-only production. Private fields/mode remain decodable historical evidence, never execution settings. */
export const OpencodeV2DevelopmentSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  profileRoot: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  connectionMode: Schema.optionalKey(Schema.Literals(["shared", "isolated"])),
  serviceFile: Schema.optionalKey(TrimmedString),
  nativeServiceTrust: Schema.optionalKey(OpencodeV2NativeServiceTrust),
  nativePluginConfigRoot: Schema.optionalKey(OpencodeV2PluginConfigRoot),
});
export type OpencodeV2DevelopmentSettings = typeof OpencodeV2DevelopmentSettings.Type;
