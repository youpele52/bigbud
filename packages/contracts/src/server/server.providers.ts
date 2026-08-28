import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import { ModelCapabilities } from "../core/model";
import { SERVER_DISCOVERY_PROVIDER_LABELS } from "../constants/provider.constant";
import { ProviderKind } from "../orchestration/orchestration";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

export const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isCustom: Schema.Boolean,
  capabilities: Schema.NullOr(ModelCapabilities),
  /** Sub-provider group label for display grouping (e.g. "Anthropic", "OpenAI"). Optional — only set by aggregator providers like OpenCode. */
  group: Schema.optional(TrimmedNonEmptyString),
  /** Sub-provider ID for routing (e.g. "openrouter", "google"). Used by the adapter to send the correct providerID in API calls. */
  subProviderID: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const ServerProviderSlashCommandInput = Schema.Struct({
  hint: TrimmedNonEmptyString,
});
export type ServerProviderSlashCommandInput = typeof ServerProviderSlashCommandInput.Type;

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(ServerProviderSlashCommandInput),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;

export const ServerProviderSlashCommands = Schema.Array(ServerProviderSlashCommand);
export type ServerProviderSlashCommands = typeof ServerProviderSlashCommands.Type;

export const ServerProviderModelDiscovery = Schema.Struct({
  status: Schema.Literals(["live", "empty", "unavailable", "invalid"]),
  source: TrimmedNonEmptyString,
  version: Schema.optional(TrimmedNonEmptyString),
  durationMs: NonNegativeInt,
});
export type ServerProviderModelDiscovery = typeof ServerProviderModelDiscovery.Type;

export const ServerProviderSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
  scope: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderSkill = typeof ServerProviderSkill.Type;

export const ServerProviderSkills = Schema.Array(ServerProviderSkill);
export type ServerProviderSkills = typeof ServerProviderSkills.Type;

export const ServerProviderRecovery = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  generation: NonNegativeInt,
  attempt: NonNegativeInt,
  maxAttempts: NonNegativeInt,
  trigger: Schema.Literals(["startup", "background", "manual"]),
  status: Schema.Literals(["retrying", "recovered", "exhausted"]),
});
export type ServerProviderRecovery = typeof ServerProviderRecovery.Type;

export const ServerProviderFailureClassification = Schema.Literals([
  "retryable",
  "user-action-required",
]);
export type ServerProviderFailureClassification = typeof ServerProviderFailureClassification.Type;

export const ServerProviderFailureReason = Schema.Literals([
  "command-not-found",
  "startup-timeout",
  "process-failed",
  "connection-refused",
  "authentication-required",
  "unsupported-version",
  "invalid-binary-path",
  "configuration-required",
]);
export type ServerProviderFailureReason = typeof ServerProviderFailureReason.Type;

export const ServerProviderFailure = Schema.Struct({
  classification: ServerProviderFailureClassification,
  reason: ServerProviderFailureReason,
});
export type ServerProviderFailure = typeof ServerProviderFailure.Type;

export const ServerProvider = Schema.Struct({
  provider: ProviderKind,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  initialProbeComplete: Schema.optional(Schema.Boolean),
  message: Schema.optional(TrimmedNonEmptyString),
  recovery: Schema.optional(ServerProviderRecovery),
  failure: Schema.optional(ServerProviderFailure),
  models: Schema.Array(ServerProviderModel),
  modelDiscovery: Schema.optional(ServerProviderModelDiscovery),
  slashCommands: ServerProviderSlashCommands,
  skills: ServerProviderSkills,
  supportsLocalRuntimeRemoteWorkspace: Schema.optional(Schema.Boolean),
  supportsSteer: Schema.optional(Schema.Boolean),
  turnControl: Schema.optional(
    Schema.Struct({
      nativeSteer: Schema.Boolean,
      interruptTarget: Schema.Literals(["exact-turn", "current-session"]),
      activeTurnInspection: Schema.Literals(["authoritative", "best-effort", "unavailable"]),
      continuation: Schema.Boolean,
    }),
  ),
});
export type ServerProvider = typeof ServerProvider.Type;

export const ServerProviders = Schema.Array(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;

export const ServerDiscoverySource = Schema.Literals([
  "project",
  "user",
  "system",
  "plugin",
  "config",
]);
export type ServerDiscoverySource = typeof ServerDiscoverySource.Type;

export const ServerDiscoveryProviderLabel = Schema.Literals(SERVER_DISCOVERY_PROVIDER_LABELS);
export type ServerDiscoveryProviderLabel = typeof ServerDiscoveryProviderLabel.Type;

const ServerDiscoveredEntryBase = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: ServerDiscoveryProviderLabel,
  name: TrimmedNonEmptyString,
  source: ServerDiscoverySource,
  description: Schema.optional(TrimmedNonEmptyString),
  sourcePath: Schema.optional(TrimmedNonEmptyString),
});

export const ServerDiscoveredAgent = ServerDiscoveredEntryBase;
export type ServerDiscoveredAgent = typeof ServerDiscoveredAgent.Type;

export const ServerDiscoveredAgents = Schema.Array(ServerDiscoveredAgent);
export type ServerDiscoveredAgents = typeof ServerDiscoveredAgents.Type;

export const ServerDiscoveredSkill = Schema.Struct({
  ...ServerDiscoveredEntryBase.fields,
  displayName: Schema.optional(TrimmedNonEmptyString),
  pluginId: Schema.optional(TrimmedNonEmptyString),
  pluginRevision: Schema.optional(TrimmedNonEmptyString),
});
export type ServerDiscoveredSkill = typeof ServerDiscoveredSkill.Type;

export const ServerDiscoveredSkills = Schema.Array(ServerDiscoveredSkill);
export type ServerDiscoveredSkills = typeof ServerDiscoveredSkills.Type;

export const ServerDiscoveryCatalog = Schema.Struct({
  agents: ServerDiscoveredAgents,
  skills: ServerDiscoveredSkills,
});
export type ServerDiscoveryCatalog = typeof ServerDiscoveryCatalog.Type;
