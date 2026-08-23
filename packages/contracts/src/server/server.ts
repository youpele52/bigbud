import { Schema } from "effect";
import { ExecutionTargetId, ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "../workspace/editor";
import { TerminalApplicationId } from "../workspace/terminalApplication";
import { ServerSettings } from "../core/settings";
import { ServerStoragePaths } from "./server.storage";
import {
  ServerLifecycleReadyPayload,
  ServerLifecycleStreamEvent,
  ServerLifecycleStreamReadyEvent,
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleWelcomePayload,
} from "./server.lifecycle";
import { ServerConfigIssues, ServerDiscoveryCatalog, ServerProviders } from "./server.providers";

export * from "./server.providers";

export const ServerObservability = Schema.Struct({
  logsDirectoryPath: TrimmedNonEmptyString,
  localTracingEnabled: Schema.Boolean,
  otlpTracesUrl: Schema.optional(TrimmedNonEmptyString),
  otlpTracesEnabled: Schema.Boolean,
  otlpMetricsUrl: Schema.optional(TrimmedNonEmptyString),
  otlpMetricsEnabled: Schema.Boolean,
});
export type ServerObservability = typeof ServerObservability.Type;

export const ServerWorkspaceCapabilities = Schema.Struct({
  remoteAgent: Schema.Struct({
    enabled: Schema.Boolean,
    supportsDirectoryWatch: Schema.Boolean,
    supportsPtyReattach: Schema.Boolean,
  }),
});
export type ServerWorkspaceCapabilities = typeof ServerWorkspaceCapabilities.Type;

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  storage: ServerStoragePaths,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  discovery: ServerDiscoveryCatalog,
  availableEditors: Schema.Array(EditorId),
  availableTerminals: Schema.optional(Schema.Array(TerminalApplicationId)),
  observability: ServerObservability,
  workspaceCapabilities: Schema.optional(ServerWorkspaceCapabilities),
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
  remoteAgent: Schema.optional(
    Schema.Union([
      Schema.Struct({ status: Schema.Literal("disabled") }),
      Schema.Struct({ status: Schema.Literal("install-required") }),
      Schema.Struct({
        status: Schema.Literal("ready"),
        version: TrimmedNonEmptyString,
      }),
    ]),
  ),
});
export type ServerVerifyExecutionTargetResult = typeof ServerVerifyExecutionTargetResult.Type;

export class ServerVerifyExecutionTargetError extends Schema.TaggedErrorClass<ServerVerifyExecutionTargetError>()(
  "ServerVerifyExecutionTargetError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ServerInstallRemoteAgentInput = Schema.Struct({
  executionTargetId: ExecutionTargetId,
});
export type ServerInstallRemoteAgentInput = typeof ServerInstallRemoteAgentInput.Type;

export const ServerInstallRemoteAgentResult = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  version: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type ServerInstallRemoteAgentResult = typeof ServerInstallRemoteAgentResult.Type;

export class ServerInstallRemoteAgentError extends Schema.TaggedErrorClass<ServerInstallRemoteAgentError>()(
  "ServerInstallRemoteAgentError",
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

export class ServerCliProxyActivationError extends Schema.TaggedErrorClass<ServerCliProxyActivationError>()(
  "ServerCliProxyActivationError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export {
  ServerLifecycleReadyPayload,
  ServerLifecycleStreamEvent,
  ServerLifecycleStreamReadyEvent,
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleWelcomePayload,
};
