import { Schema } from "effect";

import { ExecutionTargetId, TrimmedNonEmptyString } from "../core/baseSchemas";

/** Request the version-pinned command a user runs on the remote host to stage the agent. */
export const ServerGetRemoteAgentManualInstallInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
});
export type ServerGetRemoteAgentManualInstallInput =
  typeof ServerGetRemoteAgentManualInstallInput.Type;

export const ServerGetRemoteAgentManualInstallResult = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  /** Agent version selected from the signed install source. */
  version: TrimmedNonEmptyString,
  /** Copyable shell command; it stages bytes only and never activates them. */
  command: TrimmedNonEmptyString,
  scriptUrl: TrimmedNonEmptyString,
  /** The same script attached to the pinned release, for hosts that cannot reach bigbud.app. */
  releaseScriptUrl: TrimmedNonEmptyString,
  /** Home-relative directory where the script places verified bytes for adoption. */
  inboxRelativePath: TrimmedNonEmptyString,
});
export type ServerGetRemoteAgentManualInstallResult =
  typeof ServerGetRemoteAgentManualInstallResult.Type;

export const ServerInstallRemoteAgentInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  replace: Schema.optional(Schema.Boolean),
});
export type ServerInstallRemoteAgentInput = typeof ServerInstallRemoteAgentInput.Type;

/**
 * Fresh admission from the app's Connect. `replace` retires older builds once the new build is
 * active (the app's default after a staged Install or update); live work defers retirement.
 */
export const ServerConnectRemoteAgentInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  requestId: TrimmedNonEmptyString,
  intent: Schema.Literal("fresh"),
  replace: Schema.optional(Schema.Boolean),
});
export type ServerConnectRemoteAgentInput = typeof ServerConnectRemoteAgentInput.Type;
