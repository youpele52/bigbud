import * as Schema from "effect/Schema";

export class CopilotRuntimeError extends Schema.TaggedErrorClass<CopilotRuntimeError>()(
  "CopilotRuntimeError",
  { message: Schema.String },
) {}

export const CopilotRuntimeInput = Schema.Struct({
  action: Schema.Literals(["status", "install", "update", "uninstall", "cancel", "acknowledge"]),
  jobId: Schema.optionalKey(Schema.String),
});
export type CopilotRuntimeInput = typeof CopilotRuntimeInput.Type;
export const CopilotRuntimeInstallation = Schema.Struct({
  path: Schema.String,
  directory: Schema.String,
  version: Schema.String,
  target: Schema.String,
  sizeBytes: Schema.Number,
});
export type CopilotRuntimeInstallation = typeof CopilotRuntimeInstallation.Type;
export const CopilotRuntimeJob = Schema.Struct({
  operation: Schema.Literals(["install", "uninstall"]),
  id: Schema.String,
  phase: Schema.Literals([
    "downloading",
    "verifying",
    "installing",
    "installed",
    "cancelled",
    "error",
    "uninstalled",
  ]),
  version: Schema.String,
  transferredBytes: Schema.Number,
  totalBytes: Schema.Number,
  error: Schema.NullOr(Schema.String),
});
export type CopilotRuntimeJob = typeof CopilotRuntimeJob.Type;
export const CopilotRuntimeState = Schema.Struct({
  available: Schema.Boolean,
  source: Schema.Literals([
    "configured",
    "managed",
    "bundled-native",
    "existing",
    "sdk",
    "missing",
  ]),
  path: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  installedSizeBytes: Schema.NullOr(Schema.Number),
  managed: Schema.Array(CopilotRuntimeInstallation),
  activeLeases: Schema.Number,
  onboarding: Schema.Boolean,
  pinnedVersion: Schema.String,
  job: Schema.NullOr(CopilotRuntimeJob),
  error: Schema.NullOr(Schema.String),
  diagnostic: Schema.NullOr(Schema.String),
});
export type CopilotRuntimeState = typeof CopilotRuntimeState.Type;
