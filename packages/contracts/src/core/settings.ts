import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  CopilotModelOptions,
  CursorModelOptions,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  OpencodeModelOptions,
  PiModelOptions,
} from "./model";
import { ModelSelection } from "../orchestration/orchestration";
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
export const TERMINAL_FONT_SIZE_MIN = TERMINAL_FONT_SIZES[0];
export const TERMINAL_FONT_SIZE_MAX = 18;

export const TerminalFontFamily = Schema.Literals(TERMINAL_FONT_FAMILIES);
export type TerminalFontFamily = typeof TerminalFontFamily.Type;
const TerminalFontSize = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(TERMINAL_FONT_SIZE_MIN),
).check(Schema.isLessThanOrEqualTo(TERMINAL_FONT_SIZE_MAX));

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
  terminalFontSize: TerminalFontSize.pipe(Schema.withDecodingDefault(() => 12)),
  enableTaskCompletionToasts: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  enableSystemTaskCompletionNotifications: Schema.Boolean.pipe(
    Schema.withDecodingDefault(() => true),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(THREAD_ENV_MODES);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

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

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("claude"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

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

export const PiSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("pi"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type PiSettings = typeof PiSettings.Type;

export const CursorSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  binaryPath: makeBinaryPathSetting("cursor"),
  apiEndpoint: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type CursorSettings = typeof CursorSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
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
    copilot: CopilotSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    opencode: OpencodeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    pi: PiSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  }).pipe(Schema.withDecodingDefault(() => ({}))),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(() => ({}))),
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

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const CodexModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(CodexModelOptions.fields.reasoningEffort),
  fastMode: Schema.optionalKey(CodexModelOptions.fields.fastMode),
});

const ClaudeModelOptionsPatch = Schema.Struct({
  thinking: Schema.optionalKey(ClaudeModelOptions.fields.thinking),
  effort: Schema.optionalKey(ClaudeModelOptions.fields.effort),
  fastMode: Schema.optionalKey(ClaudeModelOptions.fields.fastMode),
  contextWindow: Schema.optionalKey(ClaudeModelOptions.fields.contextWindow),
});

const CopilotModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(CopilotModelOptions.fields.reasoningEffort),
});

const OpencodeModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(OpencodeModelOptions.fields.reasoningEffort),
});

const PiModelOptionsPatch = Schema.Struct({
  thinkingLevel: Schema.optionalKey(PiModelOptions.fields.thinkingLevel),
});

const CursorModelOptionsPatch = Schema.Struct({
  reasoning: Schema.optionalKey(CursorModelOptions.fields.reasoning),
  contextWindow: Schema.optionalKey(CursorModelOptions.fields.contextWindow),
  fastMode: Schema.optionalKey(CursorModelOptions.fields.fastMode),
  thinking: Schema.optionalKey(CursorModelOptions.fields.thinking),
});

const ModelSelectionPatch = Schema.Union([
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("codex")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(CodexModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("claudeAgent")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ClaudeModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("copilot")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(CopilotModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("opencode")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(OpencodeModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("pi")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(PiModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("cursor")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(CursorModelOptionsPatch),
  }),
]);

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const CopilotSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpencodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const PiSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  apiEndpoint: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  defaultChatCwd: Schema.optionalKey(Schema.String),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      copilot: Schema.optionalKey(CopilotSettingsPatch),
      opencode: Schema.optionalKey(OpencodeSettingsPatch),
      pi: Schema.optionalKey(PiSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;
