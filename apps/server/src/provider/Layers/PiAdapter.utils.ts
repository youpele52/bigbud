import {
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  type CanonicalItemType,
  type ProviderRuntimeEvent,
  type ThreadTokenUsageSnapshot,
} from "@bigbud/contracts";

import type {
  ActivePiSession,
  PiAdapterModelSelection,
  PiResumeCursor,
} from "./PiAdapter.types.ts";
import { PROVIDER } from "./PiAdapter.types.ts";

export function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

export function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPiModelSelection(value: unknown): value is PiAdapterModelSelection {
  return (
    isRecord(value) &&
    value.provider === "pi" &&
    typeof value.model === "string" &&
    value.model.trim().length > 0
  );
}

export function readResumeCursor(value: unknown): PiResumeCursor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sessionId = normalizeString(value.sessionId);
  const sessionFile = normalizeString(value.sessionFile);
  if (!sessionId && !sessionFile) {
    return undefined;
  }

  return {
    ...(sessionId ? { sessionId } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

export function toRuntimeItemId(value: string | undefined): RuntimeItemId | undefined {
  return value ? RuntimeItemId.makeUnsafe(value) : undefined;
}

export function toRuntimeRequestId(value: string | undefined): RuntimeRequestId | undefined {
  return value ? RuntimeRequestId.makeUnsafe(value) : undefined;
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value ? ProviderItemId.makeUnsafe(value) : undefined;
}

export function eventBase(input: {
  readonly eventId: import("@bigbud/contracts").EventId;
  readonly createdAt: string;
  readonly threadId: import("@bigbud/contracts").ThreadId;
  readonly turnId?: import("@bigbud/contracts").TurnId;
  readonly itemId?: string;
  readonly requestId?: string;
  readonly raw?: ProviderRuntimeEvent["raw"];
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const providerTurnId = input.turnId;
  const providerItemId = toProviderItemId(input.itemId);
  const providerRequestId = normalizeString(input.requestId);

  return {
    eventId: input.eventId,
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: toRuntimeRequestId(input.requestId) } : {}),
    ...(providerTurnId || providerItemId || providerRequestId
      ? {
          providerRefs: {
            ...(providerTurnId ? { providerTurnId } : {}),
            ...(providerItemId ? { providerItemId } : {}),
            ...(providerRequestId ? { providerRequestId } : {}),
          },
        }
      : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  };
}

export function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export function normalizeUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = typeof value.input === "number" ? Math.max(0, Math.trunc(value.input)) : 0;
  const outputTokens = typeof value.output === "number" ? Math.max(0, Math.trunc(value.output)) : 0;
  const cachedInputTokens =
    typeof value.cacheRead === "number" ? Math.max(0, Math.trunc(value.cacheRead)) : 0;
  const usedTokens = inputTokens + outputTokens + cachedInputTokens;
  const totalProcessedTokens =
    typeof value.totalTokens === "number" ? Math.max(0, Math.trunc(value.totalTokens)) : usedTokens;
  if (usedTokens <= 0 && totalProcessedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    totalProcessedTokens,
    ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens > 0
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
  };
}

export function extractTextContent(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const content = message.content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const chunks = content
    .flatMap((part) => {
      if (!isRecord(part)) {
        return [] as string[];
      }
      if (part.type === "text" && typeof part.text === "string") {
        return [part.text];
      }
      if (part.type === "thinking" && typeof part.thinking === "string") {
        return [part.thinking];
      }
      return [] as string[];
    })
    .filter((part) => part.length > 0);
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

export function resolvePiProviderForModel(input: {
  readonly model: string;
  readonly subProviderID?: string;
  readonly fallback?: string;
}) {
  if (input.subProviderID) {
    return {
      provider: input.subProviderID,
      modelId: input.model,
    };
  }

  const slashIndex = input.model.indexOf("/");
  if (slashIndex > 0 && slashIndex < input.model.length - 1) {
    const provider = input.model.slice(0, slashIndex).trim();
    const modelId = input.model.slice(slashIndex + 1).trim();
    if (provider.length > 0 && modelId.length > 0) {
      return { provider, modelId };
    }
  }

  if (input.fallback) {
    return {
      provider: input.fallback,
      modelId: input.model,
    };
  }

  return undefined;
}

export function buildThreadSnapshot(session: ActivePiSession) {
  return {
    threadId: session.threadId,
    turns: session.turns.map((turn) => ({
      id: turn.id,
      items: [...turn.items],
    })),
  };
}

export function currentTurnRecord(session: ActivePiSession) {
  const activeTurnId = session.activeTurnId;
  if (!activeTurnId) {
    return session.turns.at(-1);
  }
  return session.turns.find((turn) => turn.id === activeTurnId) ?? session.turns.at(-1);
}

export function appendTurnItem(session: ActivePiSession, item: unknown) {
  currentTurnRecord(session)?.items.push(item);
}

export function appendTurnItems(session: ActivePiSession, items: ReadonlyArray<unknown>) {
  const turn = currentTurnRecord(session);
  if (!turn || items.length === 0) {
    return;
  }
  turn.items.push(...items);
}
