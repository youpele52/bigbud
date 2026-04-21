import { Schema } from "effect";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  CopilotModelOptions,
  CursorModelOptions,
  OpencodeModelOptions,
  PiModelOptions,
} from "../core/model";
import { CommandId, TrimmedNonEmptyString } from "../core/baseSchemas";
import { DEFAULT_PROVIDER_KIND, PROVIDER_KINDS } from "../constants/provider.constant";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  RUNTIME_MODES,
  PROVIDER_INTERACTION_MODES,
  PROVIDER_APPROVAL_POLICIES,
  PROVIDER_SANDBOX_MODES,
} from "../constants/runtime.constant";
import { ORCHESTRATION_WS_METHODS } from "../constants/websocket.constant";

export {
  ORCHESTRATION_WS_METHODS,
  DEFAULT_PROVIDER_KIND,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  PROVIDER_KINDS,
};

export const ProviderKind = Schema.Literals(PROVIDER_KINDS);
export type ProviderKind = typeof ProviderKind.Type;
export const ProviderApprovalPolicy = Schema.Literals(PROVIDER_APPROVAL_POLICIES);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals(PROVIDER_SANDBOX_MODES);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

export const CodexModelSelection = Schema.Struct({
  provider: Schema.Literal("codex"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(CodexModelOptions),
});
export type CodexModelSelection = typeof CodexModelSelection.Type;

export const ClaudeModelSelection = Schema.Struct({
  provider: Schema.Literal("claudeAgent"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ClaudeModelOptions),
});
export type ClaudeModelSelection = typeof ClaudeModelSelection.Type;

export const CopilotModelSelection = Schema.Struct({
  provider: Schema.Literal("copilot"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(CopilotModelOptions),
});
export type CopilotModelSelection = typeof CopilotModelSelection.Type;

export const OpencodeModelSelection = Schema.Struct({
  provider: Schema.Literal("opencode"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(OpencodeModelOptions),
  /** Sub-provider ID for routing (e.g. "openrouter", "google"). Resolved at model enumeration time and sent back to the adapter. */
  subProviderID: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OpencodeModelSelection = typeof OpencodeModelSelection.Type;

export const PiModelSelection = Schema.Struct({
  provider: Schema.Literal("pi"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(PiModelOptions),
  /** Upstream Pi provider ID for routing (e.g. "anthropic", "openai"). */
  subProviderID: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PiModelSelection = typeof PiModelSelection.Type;

export const CursorModelSelection = Schema.Struct({
  provider: Schema.Literal("cursor"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(CursorModelOptions),
});
export type CursorModelSelection = typeof CursorModelSelection.Type;

export const ModelSelection = Schema.Union([
  CodexModelSelection,
  ClaudeModelSelection,
  CopilotModelSelection,
  OpencodeModelSelection,
  PiModelSelection,
  CursorModelSelection,
]);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals(RUNTIME_MODES);
export type RuntimeMode = typeof RuntimeMode.Type;
export const ProviderInteractionMode = Schema.Literals(PROVIDER_INTERACTION_MODES);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
