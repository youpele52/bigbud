import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.219";

export type ClaudeQueryControlSurface = Pick<
  Query,
  | "close"
  | "initializationResult"
  | "interrupt"
  | "mcpServerStatus"
  | "reconnectMcpServer"
  | "reinitialize"
  | "rewindFiles"
  | "setMaxThinkingTokens"
  | "setMcpPermissionModeOverride"
  | "setMcpServers"
  | "setModel"
  | "setPermissionMode"
  | "toggleMcpServer"
>;

export type ClaudeQueryRuntime = AsyncIterable<SDKMessage> & ClaudeQueryControlSurface;

export type ClaudeInterruptReceipt = Awaited<ReturnType<ClaudeQueryRuntime["interrupt"]>>;
export type ClaudeInitializationResult = Awaited<
  ReturnType<ClaudeQueryRuntime["initializationResult"]>
>;
export type ClaudeMcpServerStatuses = Awaited<ReturnType<ClaudeQueryRuntime["mcpServerStatus"]>>;
export type ClaudeMcpPermissionModeOverrideResult = Awaited<
  ReturnType<ClaudeQueryRuntime["setMcpPermissionModeOverride"]>
>;
export type ClaudeMcpSetServersResult = Awaited<ReturnType<ClaudeQueryRuntime["setMcpServers"]>>;
export type ClaudeRewindFilesResult = Awaited<ReturnType<ClaudeQueryRuntime["rewindFiles"]>>;

export interface ClaudeSdkMessageDiscriminator {
  readonly type: string;
  readonly subtype?: string;
}

export function claudeSdkMessageDiscriminator(value: unknown): ClaudeSdkMessageDiscriminator {
  if (!value || typeof value !== "object") {
    return { type: typeof value };
  }

  const record = value as { type?: unknown; subtype?: unknown };
  return {
    type: typeof record.type === "string" ? record.type : "unknown",
    ...(typeof record.subtype === "string" ? { subtype: record.subtype } : {}),
  };
}

export function claudeSdkMessageLabel(value: unknown): string {
  const discriminator = claudeSdkMessageDiscriminator(value);
  return discriminator.subtype
    ? `${discriminator.type}/${discriminator.subtype}`
    : discriminator.type;
}
