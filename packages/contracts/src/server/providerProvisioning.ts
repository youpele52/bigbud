import * as Schema from "effect/Schema";

import { CopilotRuntimeJob } from "./copilotRuntime";

/**
 * Provider provisioning status and action (P7 increment 5, WP-5C). Schema only.
 *
 * Decision 6: bigbud provisions only Copilot (its pinned runtime) and Pi (the graph closure).
 * Every other provider reuses a user-installed tool; the action reports the exact manual
 * commands and never runs a vendor installer.
 */
export const ProvisionableProviderKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "cliProxy",
  "copilot",
  "cursor",
  "devin",
  "muse",
  "opencodeV2",
  "pi",
]);
export type ProvisionableProviderKind = typeof ProvisionableProviderKind.Type;

/**
 * - `ready`: installed and the provider's own readiness check reports it usable.
 * - `needs-auth`: installed, but the readiness check reports it unauthenticated.
 * - `missing`: a required executable or package is not on this host.
 * - `unsupported`: bigbud has no artifact for this host's OS/arch/libc tuple.
 * - `disabled`: turned off in settings, so its readiness check does not run.
 * - `unknown`: installed, but no conclusive readiness result is available yet.
 */
export const ProviderProvisioningState = Schema.Literals([
  "ready",
  "needs-auth",
  "missing",
  "unsupported",
  "disabled",
  "unknown",
]);
export type ProviderProvisioningState = typeof ProviderProvisioningState.Type;

export const ProviderProvisioningEntry = Schema.Struct({
  provider: ProvisionableProviderKind,
  displayName: Schema.String,
  provisionedBy: Schema.Literals(["bigbud", "user"]),
  state: ProviderProvisioningState,
  /** Resolved executable, or null for bundled-only providers and missing tools. */
  executablePath: Schema.NullOr(Schema.String),
  executableSource: Schema.NullOr(
    Schema.Literals(["explicit", "discovered", "bundled", "managed", "existing", "sdk"]),
  ),
  /** The manual sign-in step the user runs on the host; bigbud never signs in for the user. */
  authStep: Schema.String,
  /** The existing readiness check (`module#export`) whose snapshot decides auth. */
  authCheck: Schema.String,
  manualCommands: Schema.Array(Schema.String),
  docsUrl: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
});
export type ProviderProvisioningEntry = typeof ProviderProvisioningEntry.Type;

export const ProviderProvisioningStatusInput = Schema.Struct({
  provider: Schema.optionalKey(ProvisionableProviderKind),
});
export type ProviderProvisioningStatusInput = typeof ProviderProvisioningStatusInput.Type;

export const ProviderProvisioningStatus = Schema.Struct({
  /** `discovered` in remote mode (bounded service PATH), `inherited` elsewhere. */
  servicePath: Schema.Literals(["discovered", "inherited"]),
  providers: Schema.Array(ProviderProvisioningEntry),
});
export type ProviderProvisioningStatus = typeof ProviderProvisioningStatus.Type;

export const ProviderProvisionInput = Schema.Struct({ provider: ProvisionableProviderKind });
export type ProviderProvisionInput = typeof ProviderProvisionInput.Type;

/**
 * - `installing`: bigbud started its pinned Copilot runtime install (see `copilotJob`).
 * - `available`: nothing to install (ready, bundled in the graph, or an explicit path is kept).
 * - `needs-install`: install manually with `manualCommands`; bigbud ran nothing.
 * - `needs-auth`: installed; run `authStep` on the host.
 * - `unsupported`: no bigbud artifact for this host.
 */
export const ProviderProvisionOutcome = Schema.Literals([
  "installing",
  "available",
  "needs-install",
  "needs-auth",
  "unsupported",
]);
export type ProviderProvisionOutcome = typeof ProviderProvisionOutcome.Type;

export const ProviderProvisionResult = Schema.Struct({
  outcome: ProviderProvisionOutcome,
  entry: ProviderProvisioningEntry,
  copilotJob: Schema.NullOr(CopilotRuntimeJob),
});
export type ProviderProvisionResult = typeof ProviderProvisionResult.Type;

export class ProviderProvisioningError extends Schema.TaggedErrorClass<ProviderProvisioningError>()(
  "ProviderProvisioningError",
  {
    code: Schema.Literals(["unauthorized", "failed"]),
    message: Schema.String,
  },
) {}
