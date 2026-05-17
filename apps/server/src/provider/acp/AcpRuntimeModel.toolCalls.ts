import type * as EffectAcpSchema from "effect-acp/schema";

import type { ToolLifecycleItemType } from "@bigbud/contracts";
import { deriveToolActivityPresentation } from "@bigbud/shared/toolActivity";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AcpToolCallState {
  readonly toolCallId: string;
  readonly kind?: string;
  readonly title?: string;
  readonly status?: "pending" | "inProgress" | "completed" | "failed";
  readonly command?: string;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
}

type AcpToolCallUpdate = Extract<
  EffectAcpSchema.SessionNotification["update"],
  { readonly sessionUpdate: "tool_call" | "tool_call_update" }
>;

export function normalizePlanStepStatus(raw: unknown): "pending" | "inProgress" | "completed" {
  switch (raw) {
    case "completed":
      return "completed";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    default:
      return "pending";
  }
}

function normalizeToolCallStatus(
  raw: unknown,
  fallback?: "pending" | "inProgress" | "completed" | "failed",
): "pending" | "inProgress" | "completed" | "failed" | undefined {
  switch (raw) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return fallback;
  }
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => (typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : null))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const match = /`([^`]+)`/.exec(title);
  return match?.[1]?.trim() || undefined;
}

function extractToolCallCommand(rawInput: unknown, title: string | undefined): string | undefined {
  if (isRecord(rawInput)) {
    const directCommand = normalizeCommandValue(rawInput.command);
    if (directCommand) {
      return directCommand;
    }
    const executable = typeof rawInput.executable === "string" ? rawInput.executable.trim() : "";
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) {
      return `${executable} ${args}`;
    }
    if (executable) {
      return executable;
    }
  }
  return extractCommandFromTitle(title);
}

function extractTextContentFromToolCallContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): string | undefined {
  if (!content) return undefined;
  const chunks = content
    .map((entry) => {
      if (entry.type !== "content") {
        return undefined;
      }
      const nestedContent = entry.content;
      if (nestedContent.type !== "text") {
        return undefined;
      }
      return nestedContent.text.trim().length > 0 ? nestedContent.text.trim() : undefined;
    })
    .filter((entry): entry is string => entry !== undefined);
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

export function normalizeToolKind(kind: unknown): string | undefined {
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : undefined;
}

function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

export function makeToolCallState(
  input: {
    readonly toolCallId: string;
    readonly title?: string | null | undefined;
    readonly kind?: EffectAcpSchema.ToolKind | null | undefined;
    readonly status?: EffectAcpSchema.ToolCallStatus | null | undefined;
    readonly rawInput?: unknown;
    readonly rawOutput?: unknown;
    readonly content?: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined;
    readonly locations?: ReadonlyArray<EffectAcpSchema.ToolCallLocation> | null | undefined;
  },
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  const toolCallId = input.toolCallId.trim();
  if (!toolCallId) {
    return undefined;
  }
  const title = input.title?.trim() || undefined;
  const command = extractToolCallCommand(input.rawInput, title);
  const textContent = extractTextContentFromToolCallContent(input.content);
  const normalizedTitle =
    title && title.toLowerCase() !== "terminal" && title.toLowerCase() !== "tool call"
      ? title
      : undefined;
  const data: Record<string, unknown> = { toolCallId };
  const kind = normalizeToolKind(input.kind);
  if (kind) {
    data.kind = kind;
  }
  if (command) {
    data.command = command;
  }
  if (input.rawInput !== undefined) {
    data.rawInput = input.rawInput;
  }
  if (input.rawOutput !== undefined) {
    data.rawOutput = input.rawOutput;
  }
  if (input.content !== undefined) {
    data.content = input.content;
  }
  if (input.locations !== undefined) {
    data.locations = input.locations;
  }
  const fallbackDetail = command ?? normalizedTitle ?? textContent;
  const hasPresentationSeed =
    title !== undefined ||
    kind !== undefined ||
    command !== undefined ||
    normalizedTitle !== undefined ||
    textContent !== undefined;
  const presentation = hasPresentationSeed
    ? deriveToolActivityPresentation({
        itemType: canonicalItemTypeFromAcpToolKind(kind),
        title,
        detail: fallbackDetail,
        data,
        fallbackSummary: title ?? "Tool",
      })
    : undefined;
  const status = normalizeToolCallStatus(input.status, options?.fallbackStatus);
  return {
    toolCallId,
    ...(kind ? { kind } : {}),
    ...(presentation?.summary ? { title: presentation.summary } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(presentation?.detail ? { detail: presentation.detail } : {}),
    data,
  };
}

export function parseTypedToolCallState(
  event: AcpToolCallUpdate,
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  return makeToolCallState(
    {
      toolCallId: event.toolCallId,
      title: event.title,
      kind: event.kind,
      status: event.status,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      content: event.content,
      locations: event.locations,
    },
    options,
  );
}
