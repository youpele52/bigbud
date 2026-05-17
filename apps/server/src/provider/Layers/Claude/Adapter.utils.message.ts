import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type ProviderSendTurnInput } from "@bigbud/contracts";
import { applyClaudePromptEffortPrefix, trimOrNull } from "@bigbud/shared/model";

import { getClaudeModelCapabilities } from "./Provider.ts";

export function buildPromptText(input: ProviderSendTurnInput): string {
  const rawEffort =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.options?.effort : null;
  const claudeModel =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.model : undefined;
  const caps = getClaudeModelCapabilities(claudeModel);
  const trimmedEffort = trimOrNull(rawEffort);
  const promptEffort =
    trimmedEffort && caps.promptInjectedEffortLevels.includes(trimmedEffort) ? trimmedEffort : null;
  return applyClaudePromptEffortPrefix(input.input?.trim() ?? "", promptEffort);
}

export function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent as unknown as SDKUserMessage["message"]["content"],
    },
  } as SDKUserMessage;
}

export function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}
