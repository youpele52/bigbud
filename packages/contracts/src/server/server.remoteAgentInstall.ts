import { Schema } from "effect";

import { ExecutionTargetId, ProjectId, TrimmedNonEmptyString } from "../core/baseSchemas";

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
  /**
   * Where the command downloads the script: `https://bigbud.app/download/v<version>/remote-agent`,
   * which redirects to the pinned release asset, or that asset directly for a non-default
   * release repository.
   */
  scriptUrl: TrimmedNonEmptyString,
  /**
   * The version-stamped script attached to the pinned GitHub release, for hosts that cannot reach
   * bigbud.app.
   */
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

/**
 * Remove the bigbud remote agent from a host: deletes only `~/.bigbud/agent`, then disconnects the
 * host. `switchWorkspacesToDirectSsh` (default true) moves that host's workspaces to Direct SSH.
 */
export const ServerRemoveRemoteAgentInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  switchWorkspacesToDirectSsh: Schema.optional(Schema.Boolean),
});
export type ServerRemoveRemoteAgentInput = typeof ServerRemoveRemoteAgentInput.Type;

/** Live work or a dependent service that prevents removal; nothing was deleted. */
export const ServerRemoteAgentRemovalBlocker = Schema.Struct({
  kind: Schema.Literals([
    "terminal",
    "process",
    "watcher",
    "stage",
    "admission",
    "backend-runtime",
  ]),
  label: TrimmedNonEmptyString,
});
export type ServerRemoteAgentRemovalBlocker = typeof ServerRemoteAgentRemovalBlocker.Type;

export const ServerRemoveRemoteAgentResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("removed"),
    /** Connections to the host that were closed; the person reconnects explicitly. */
    disconnected: Schema.Number,
    switchedWorkspaceIds: Schema.Array(ProjectId),
  }),
  Schema.Struct({
    outcome: Schema.Literal("blocked"),
    blockers: Schema.Array(ServerRemoteAgentRemovalBlocker),
  }),
  Schema.Struct({
    outcome: Schema.Literal("failed"),
    message: TrimmedNonEmptyString,
  }),
]);
export type ServerRemoveRemoteAgentResult = typeof ServerRemoveRemoteAgentResult.Type;
