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

export type ClaudeImageMimeType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

export function isClaudeImageMimeType(value: string): value is ClaudeImageMimeType {
  return (
    value === "image/gif" ||
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/webp"
  );
}

export type ClaudeSdkUserContent = Exclude<SDKUserMessage["message"]["content"], string>;
export type ClaudeSdkUserContentBlock =
  ClaudeSdkUserContent extends ReadonlyArray<infer Block> ? Block : never;

export function buildUserMessage(input: {
  readonly sdkContent: ClaudeSdkUserContent;
}): SDKUserMessage {
  return {
    type: "user",
    uuid: crypto.randomUUID(),
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent,
    },
  };
}

export function buildClaudeImageContentBlock(input: {
  readonly mimeType: ClaudeImageMimeType;
  readonly bytes: Uint8Array;
}): ClaudeSdkUserContentBlock {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}
