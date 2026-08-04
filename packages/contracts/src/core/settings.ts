import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedString } from "./baseSchemas";
import { ModelSelection } from "../orchestration/orchestration";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "./model";
import {
  TIMESTAMP_FORMATS,
  DEFAULT_TIMESTAMP_FORMAT,
  SIDEBAR_PROJECT_SORT_ORDERS,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  SIDEBAR_THREAD_SORT_ORDERS,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  THREAD_ENV_MODES,
} from "../constants/settings.constant";
import { DEFAULT_PROVIDER_KIND } from "../constants/provider.constant";
import { ThreadRetentionPolicy } from "./settings.threadRetention";
import {
  AgentBrowserPreference,
  ComputerUseActionTimeoutMs,
  ComputerUseCheckInIntervalMs,
  DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS,
  DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS,
  ThreadEnvMode,
} from "./settings.serverShared";

export * from "./settings.serverPatch";
export * from "./settings.threadRetention";
export {
  AgentBrowserPreference,
  COMPUTER_USE_ACTION_TIMEOUT_MS_MAX,
  COMPUTER_USE_ACTION_TIMEOUT_MS_MIN,
  COMPUTER_USE_CHECK_IN_INTERVAL_MS_MAX,
  COMPUTER_USE_CHECK_IN_INTERVAL_MS_MIN,
  ComputerUseActionTimeoutMs,
  ComputerUseCheckInIntervalMs,
  DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS,
  DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS,
  ThreadEnvMode,
} from "./settings.serverShared";

const DEFAULT_CHAT_CWD = "~/Documents";

export {
  TIMESTAMP_FORMATS,
  DEFAULT_TIMESTAMP_FORMAT,
  SIDEBAR_PROJECT_SORT_ORDERS,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  SIDEBAR_THREAD_SORT_ORDERS,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  THREAD_ENV_MODES,
};

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(TIMESTAMP_FORMATS);
export type TimestampFormat = typeof TimestampFormat.Type;

export const SidebarProjectSortOrder = Schema.Literals(SIDEBAR_PROJECT_SORT_ORDERS);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;

export const SidebarThreadSortOrder = Schema.Literals(SIDEBAR_THREAD_SORT_ORDERS);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;

export const TERMINAL_FONT_FAMILIES = ["meslo-nerd-font-mono", "system-monospace"] as const;
export const TERMINAL_FONT_SIZES = [11, 12, 13, 14, 15, 16, 17, 18] as const;
export const DESKTOP_WINDOW_MATERIALS = ["automatic", "solid", "translucent"] as const;
export const TERMINAL_FONT_SIZE_MIN = TERMINAL_FONT_SIZES[0];
export const TERMINAL_FONT_SIZE_MAX = 18;
export const CONTEXT_WINDOW_WARNING_THRESHOLD_MIN = 60_000;
export const CONTEXT_WINDOW_WARNING_THRESHOLD_MAX = 1_000_000;
export const DEFAULT_CONTEXT_WINDOW_WARNING_THRESHOLD = 120_000;

export const TerminalFontFamily = Schema.Literals(TERMINAL_FONT_FAMILIES);
export type TerminalFontFamily = typeof TerminalFontFamily.Type;
export const DesktopWindowMaterial = Schema.Literals(DESKTOP_WINDOW_MATERIALS);
export type DesktopWindowMaterial = typeof DesktopWindowMaterial.Type;
const TerminalFontSize = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(TERMINAL_FONT_SIZE_MIN),
).check(Schema.isLessThanOrEqualTo(TERMINAL_FONT_SIZE_MAX));
const ContextWindowWarningThreshold = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(CONTEXT_WINDOW_WARNING_THRESHOLD_MIN),
).check(Schema.isLessThanOrEqualTo(CONTEXT_WINDOW_WARNING_THRESHOLD_MAX));

export const ClientSettingsSchema = Schema.Struct({
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_PROJECT_SORT_ORDER),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_THREAD_SORT_ORDER),
  ),
  sidebarChatsSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_THREAD_SORT_ORDER),
  ),
  timestampFormat: TimestampFormat.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMESTAMP_FORMAT)),
  terminalFontFamily: TerminalFontFamily.pipe(
    Schema.withDecodingDefault(() => "meslo-nerd-font-mono" as const satisfies TerminalFontFamily),
  ),
  windowMaterial: DesktopWindowMaterial.pipe(
    Schema.withDecodingDefault(() => "automatic" as const satisfies DesktopWindowMaterial),
  ),
  terminalFontSize: TerminalFontSize.pipe(Schema.withDecodingDefault(() => 12)),
  contextWindowWarningThresholdTokens: ContextWindowWarningThreshold.pipe(
    Schema.withDecodingDefault(() => DEFAULT_CONTEXT_WINDOW_WARNING_THRESHOLD),
  ),
  enableTaskCompletionToasts: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  enableSystemTaskCompletionNotifications: Schema.Boolean.pipe(
    Schema.withDecodingDefault(() => true),
  ),
  fileAccessPermissionLevel: Schema.Literals([
    "none",
    "common-folders",
    "unrestricted",
  ] as const).pipe(Schema.withDecodingDefault(() => "none")),
  hasSeenFileAccessPrompt: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(() => fallback),
  );

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeRolloutSettings = Schema.Struct({
  modernTaskExposure: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  boundedHookProgress: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  forwardedSubagentText: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  mcpControls: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  fileCheckpointRewind: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  nativeFork: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type ClaudeRolloutSettings = typeof ClaudeRolloutSettings.Type;

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("claude"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
  rollout: ClaudeRolloutSettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CliProxySettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  configPath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
});
export type CliProxySettings = typeof CliProxySettings.Type;

export const CopilotSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("copilot"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type CopilotSettings = typeof CopilotSettings.Type;

export const OpencodeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("opencode"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type OpencodeSettings = typeof OpencodeSettings.Type;

export const KilocodeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("kilo"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type KilocodeSettings = typeof KilocodeSettings.Type;

export const PiSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("pi"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type PiSettings = typeof PiSettings.Type;

export const CursorSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("agent"),
  apiEndpoint: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type CursorSettings = typeof CursorSettings.Type;

export const DevinSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("devin"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type DevinSettings = typeof DevinSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const MobileRemoteControlSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type MobileRemoteControlSettings = typeof MobileRemoteControlSettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  enableThinkingStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(() => "local" as const satisfies ThreadEnvMode),
  ),
  defaultChatCwd: TrimmedString.pipe(Schema.withDecodingDefault(() => DEFAULT_CHAT_CWD)),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(() => ({
      provider: DEFAULT_PROVIDER_KIND,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_KIND],
    })),
  ),

  // Provider specific settings
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    cliProxy: CliProxySettings.pipe(Schema.withDecodingDefault(() => ({}))),
    copilot: CopilotSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    kilocode: KilocodeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    opencode: OpencodeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    pi: PiSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    devin: DevinSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  }).pipe(Schema.withDecodingDefault(() => ({}))),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(() => ({}))),
  mobileRemoteControl: MobileRemoteControlSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  threadRetentionPolicy: ThreadRetentionPolicy.pipe(
    Schema.withDecodingDefault(() => "never" as const),
  ),
  agentBrowserPreference: AgentBrowserPreference.pipe(
    Schema.withDecodingDefault(() => "bigbud" as const satisfies AgentBrowserPreference),
  ),
  computerUseEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  hasSeenComputerUsePrompt: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  computerUseCheckInIntervalMs: ComputerUseCheckInIntervalMs.pipe(
    Schema.withDecodingDefault(() => DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS),
  ),
  computerUseActionTimeoutMs: ComputerUseActionTimeoutMs.pipe(
    Schema.withDecodingDefault(() => DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};
