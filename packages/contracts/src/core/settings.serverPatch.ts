import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  CopilotModelOptions,
  CursorModelOptions,
  DevinModelOptions,
  KilocodeModelOptions,
  OpencodeModelOptions,
  PiModelOptions,
} from "./model";
import {
  AgentBrowserPreference,
  ComputerUseActionTimeoutMs,
  ComputerUseCheckInIntervalMs,
  ThreadEnvMode,
} from "./settings.serverShared";

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

const KilocodeModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(KilocodeModelOptions.fields.reasoningEffort),
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

const DevinModelOptionsPatch = Schema.Struct({
  reasoning: Schema.optionalKey(DevinModelOptions.fields.reasoning),
  contextWindow: Schema.optionalKey(DevinModelOptions.fields.contextWindow),
  fastMode: Schema.optionalKey(DevinModelOptions.fields.fastMode),
  thinking: Schema.optionalKey(DevinModelOptions.fields.thinking),
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
    provider: Schema.optionalKey(Schema.Literal("cliProxy")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
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
    provider: Schema.optionalKey(Schema.Literal("kilocode")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(KilocodeModelOptionsPatch),
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
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("devin")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(DevinModelOptionsPatch),
  }),
]);

const ProviderSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  enableThinkingStreaming: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  defaultChatCwd: Schema.optionalKey(Schema.String),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  mobileRemoteControl: Schema.optionalKey(
    Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }),
  ),
  agentBrowserPreference: Schema.optionalKey(AgentBrowserPreference),
  computerUseEnabled: Schema.optionalKey(Schema.Boolean),
  hasSeenComputerUsePrompt: Schema.optionalKey(Schema.Boolean),
  computerUseCheckInIntervalMs: Schema.optionalKey(ComputerUseCheckInIntervalMs),
  computerUseActionTimeoutMs: Schema.optionalKey(ComputerUseActionTimeoutMs),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsPatch.fields,
          homePath: Schema.optionalKey(Schema.String),
        }),
      ),
      claudeAgent: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsPatch.fields,
          rollout: Schema.optionalKey(
            Schema.Struct({
              modernTaskExposure: Schema.optionalKey(Schema.Boolean),
              boundedHookProgress: Schema.optionalKey(Schema.Boolean),
              forwardedSubagentText: Schema.optionalKey(Schema.Boolean),
              mcpControls: Schema.optionalKey(Schema.Boolean),
              fileCheckpointRewind: Schema.optionalKey(Schema.Boolean),
              nativeFork: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        }),
      ),
      cliProxy: Schema.optionalKey(
        Schema.Struct({
          enabled: Schema.optionalKey(Schema.Boolean),
          configPath: Schema.optionalKey(Schema.String),
        }),
      ),
      copilot: Schema.optionalKey(ProviderSettingsPatch),
      kilocode: Schema.optionalKey(ProviderSettingsPatch),
      opencode: Schema.optionalKey(ProviderSettingsPatch),
      pi: Schema.optionalKey(ProviderSettingsPatch),
      cursor: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsPatch.fields,
          apiEndpoint: Schema.optionalKey(Schema.String),
        }),
      ),
      devin: Schema.optionalKey(ProviderSettingsPatch),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;
