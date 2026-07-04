import { Schema } from "effect";
import {
  ExecutionTargetId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "../workspace/editor";
import { ModelCapabilities } from "../core/model";
import { ProviderKind } from "../orchestration/orchestration";
import { SERVER_DISCOVERY_PROVIDER_LABELS } from "../constants/provider.constant";
import { ServerSettings } from "../core/settings";
import { ServerStoragePaths } from "./server.storage";
import {
  ServerLifecycleReadyPayload,
  ServerLifecycleStreamEvent,
  ServerLifecycleStreamReadyEvent,
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleWelcomePayload,
} from "./server.lifecycle";

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

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

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

export const ServerProvider = Schema.Struct({
  provider: ProviderKind,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  slashCommands: ServerProviderSlashCommands,
  skills: ServerProviderSkills,
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
});
export type ServerDiscoveredSkill = typeof ServerDiscoveredSkill.Type;

export const ServerDiscoveredSkills = Schema.Array(ServerDiscoveredSkill);
export type ServerDiscoveredSkills = typeof ServerDiscoveredSkills.Type;

export const ServerDiscoveryCatalog = Schema.Struct({
  agents: ServerDiscoveredAgents,
  skills: ServerDiscoveredSkills,
});
export type ServerDiscoveryCatalog = typeof ServerDiscoveryCatalog.Type;

export const ServerObservability = Schema.Struct({
  logsDirectoryPath: TrimmedNonEmptyString,
  localTracingEnabled: Schema.Boolean,
  otlpTracesUrl: Schema.optional(TrimmedNonEmptyString),
  otlpTracesEnabled: Schema.Boolean,
  otlpMetricsUrl: Schema.optional(TrimmedNonEmptyString),
  otlpMetricsEnabled: Schema.Boolean,
});
export type ServerObservability = typeof ServerObservability.Type;

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  storage: ServerStoragePaths,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  discovery: ServerDiscoveryCatalog,
  availableEditors: Schema.Array(EditorId),
  observability: ServerObservability,
  settings: ServerSettings,
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerReadDocumentUrlInput = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type ServerReadDocumentUrlInput = typeof ServerReadDocumentUrlInput.Type;

export const ServerReadDocumentUrlResult = Schema.Struct({
  sourceUrl: TrimmedNonEmptyString,
  resolvedUrl: TrimmedNonEmptyString,
  title: Schema.NullOr(TrimmedNonEmptyString),
  text: TrimmedNonEmptyString,
});
export type ServerReadDocumentUrlResult = typeof ServerReadDocumentUrlResult.Type;

export class ServerReadDocumentUrlError extends Schema.TaggedErrorClass<ServerReadDocumentUrlError>()(
  "ServerReadDocumentUrlError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ServerWriteHandoffDocumentInput = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  content: TrimmedNonEmptyString,
});
export type ServerWriteHandoffDocumentInput = typeof ServerWriteHandoffDocumentInput.Type;

export const ServerWriteHandoffDocumentResult = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type ServerWriteHandoffDocumentResult = typeof ServerWriteHandoffDocumentResult.Type;

export class ServerWriteHandoffDocumentError extends Schema.TaggedErrorClass<ServerWriteHandoffDocumentError>()(
  "ServerWriteHandoffDocumentError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ServerExportThreadContextInput = Schema.Struct({
  threadId: ThreadId,
});
export type ServerExportThreadContextInput = typeof ServerExportThreadContextInput.Type;

export const ServerExportThreadContextResult = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type ServerExportThreadContextResult = typeof ServerExportThreadContextResult.Type;

export class ServerExportThreadContextError extends Schema.TaggedErrorClass<ServerExportThreadContextError>()(
  "ServerExportThreadContextError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ServerVerifyExecutionTargetInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ServerVerifyExecutionTargetInput = typeof ServerVerifyExecutionTargetInput.Type;

export const ServerVerifyExecutionTargetResult = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  message: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ServerVerifyExecutionTargetResult = typeof ServerVerifyExecutionTargetResult.Type;

export class ServerVerifyExecutionTargetError extends Schema.TaggedErrorClass<ServerVerifyExecutionTargetError>()(
  "ServerVerifyExecutionTargetError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ServerUnlockSshKeyInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  passphrase: TrimmedNonEmptyString,
});
export type ServerUnlockSshKeyInput = typeof ServerUnlockSshKeyInput.Type;

export const ServerUnlockSshKeyResult = Schema.Struct({
  message: TrimmedNonEmptyString,
});
export type ServerUnlockSshKeyResult = typeof ServerUnlockSshKeyResult.Type;

export class ServerUnlockSshKeyError extends Schema.TaggedErrorClass<ServerUnlockSshKeyError>()(
  "ServerUnlockSshKeyError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ServerUnlockSshPasswordInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  password: TrimmedNonEmptyString,
});
export type ServerUnlockSshPasswordInput = typeof ServerUnlockSshPasswordInput.Type;

export const ServerUnlockSshPasswordResult = Schema.Struct({
  message: TrimmedNonEmptyString,
});
export type ServerUnlockSshPasswordResult = typeof ServerUnlockSshPasswordResult.Type;

export class ServerUnlockSshPasswordError extends Schema.TaggedErrorClass<ServerUnlockSshPasswordError>()(
  "ServerUnlockSshPasswordError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviders,
  discovery: ServerDiscoveryCatalog,
  settings: Schema.optional(ServerSettings),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;

export const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

export const ServerConfigDiscoveryUpdatedPayload = Schema.Struct({
  discovery: ServerDiscoveryCatalog,
});
export type ServerConfigDiscoveryUpdatedPayload = typeof ServerConfigDiscoveryUpdatedPayload.Type;

export const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

export const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;

export const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;

export const ServerConfigStreamProviderStatusesEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
export type ServerConfigStreamProviderStatusesEvent =
  typeof ServerConfigStreamProviderStatusesEvent.Type;

export const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;

export const ServerConfigStreamDiscoveryUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("discoveryUpdated"),
  payload: ServerConfigDiscoveryUpdatedPayload,
});
export type ServerConfigStreamDiscoveryUpdatedEvent =
  typeof ServerConfigStreamDiscoveryUpdatedEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamDiscoveryUpdatedEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export {
  ServerLifecycleReadyPayload,
  ServerLifecycleStreamEvent,
  ServerLifecycleStreamReadyEvent,
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleWelcomePayload,
};
