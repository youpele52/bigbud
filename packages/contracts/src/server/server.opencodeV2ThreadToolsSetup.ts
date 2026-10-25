import * as Schema from "effect/Schema";
import { ThreadId } from "../core/baseSchemas";

const Directory = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isPattern(/^(\/|[A-Za-z]:[\\/])/),
);
export const ServerOpencodeV2ThreadToolsSetupRequest = Schema.Struct({
  operation: Schema.optionalKey(Schema.Literal("setup")),
  directory: Schema.optionalKey(Directory),
  threadId: Schema.optionalKey(ThreadId),
  refresh: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
const Handle = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
export const ServerOpencodeV2ThreadToolsSetupStatusInput = Schema.Struct({
  operation: Schema.Literal("status"),
  jobId: Handle,
});
export const ServerOpencodeV2ThreadToolsSetupCancelInput = Schema.Struct({
  operation: Schema.Literal("cancel-interest"),
  jobId: Handle,
  interestId: Handle,
});
export const ServerOpencodeV2ThreadToolsSetupInput = Schema.Union([
  ServerOpencodeV2ThreadToolsSetupRequest,
  ServerOpencodeV2ThreadToolsSetupStatusInput,
  ServerOpencodeV2ThreadToolsSetupCancelInput,
]);
export type ServerOpencodeV2ThreadToolsSetupInput =
  typeof ServerOpencodeV2ThreadToolsSetupInput.Type;
export const ServerOpencodeV2ThreadToolsSetupResult = Schema.Struct({
  status: Schema.Literals(["required", "ready", "incompatible-history", "unavailable"]),
  directory: Directory,
  artifactDirectoryUri: Schema.String,
  artifactDigest: Schema.String,
  issuerKeyId: Schema.String,
  configAddition: Schema.Struct({ plugins: Schema.Array(Schema.String) }),
  message: Schema.String,
  nativePluginConfigRoot: Schema.optionalKey(Schema.String),
  severity: Schema.optionalKey(Schema.Literals(["info", "success", "warning", "error"])),
  activationState: Schema.optionalKey(
    Schema.Literals([
      "checking",
      "prepared",
      "waiting-for-idle",
      "closing-gate",
      "retiring",
      "publishing",
      "verifying",
      "ready",
      "blocked",
      "failed",
      "uncertain",
      "cancelled",
      "deferred",
    ]),
  ),
  installedBootstrapDigest: Schema.optionalKey(Schema.String),
  desiredBootstrapDigest: Schema.optionalKey(Schema.String),
  activeImplementationDigest: Schema.optionalKey(Schema.String),
  defaultImplementationDigest: Schema.optionalKey(Schema.String),
  retryAfter: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  reasonCode: Schema.optionalKey(Schema.String),
  nativeVersion: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(50))),
  nativeContractDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  qualificationState: Schema.optionalKey(
    Schema.Literals(["qualified", "unqualified", "required", "incompatible"]),
  ),
  qualificationRecordId: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ),
  semanticProfile: Schema.optionalKey(
    Schema.Literals(["v2-global-config-v1", "v2-system-global-config-v1"]),
  ),
  jobId: Schema.optionalKey(Handle),
  interestId: Schema.optionalKey(Handle),
});
export type ServerOpencodeV2ThreadToolsSetupResult =
  typeof ServerOpencodeV2ThreadToolsSetupResult.Type;
