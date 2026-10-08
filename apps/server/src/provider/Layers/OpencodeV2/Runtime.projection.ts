import type { SessionMessageInfo, SessionMessageAssistant, TokenUsageInfo } from "@opencode/client";
import { EventId, RuntimeItemId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import { V2ResponseSizeError } from "./Client.response.ts";
import { authoritativeAssistantRepair, isV2AssistantSettled } from "./Projection.ts";
import { createHash } from "node:crypto";
import { V2_MEDIA_RESPONSE_BYTES } from "./Media.limits.ts";

/** Sequence order comes from native message projection, never wall-clock sorting. */
export async function readV2Messages(session: V2RuntimeSession): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  let limit = 100;
  for (let page = 0; page < 10000; page++) {
    const read = () =>
      v2Request("message.list", (signal) =>
        session.lease.process.client.message.list(
          {
            sessionID: session.native.id,
            order: "asc",
            limit,
            ...(cursor ? { cursor } : {}),
          },
          { signal },
        ),
      );
    // Retained media can overflow a multi-message page after restart. Reads may narrow their page, never re-admit or retry a mutation.
    const result = await read().catch((error) => {
      if (limit === 1 || !(error instanceof V2ResponseSizeError)) throw error;
      limit = 1;
      return read();
    });
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (
      bytes > 2 * V2_MEDIA_RESPONSE_BYTES ||
      result.data.length > limit ||
      messages.length + result.data.length > 10000
    )
      throw new Error("V2 projection safety bound exceeded.");
    messages.push(...result.data);
    // Native cursors are navigation anchors, not evidence another page exists.
    // A short page exhausts this bounded read; later appends are repaired next poll.
    if (result.data.length < limit) return messages;
    if (!result.cursor && result.data.length === limit)
      throw new Error("V2 full cursorless projection page is unconfirmed.");
    cursor = result.cursor?.next ?? undefined;
    if (!cursor) return messages;
    if (cursors.has(cursor)) throw new Error("V2 projection cursor repeated.");
    cursors.add(cursor);
  }
  throw new Error("V2 projection page bound exceeded; completion remains unconfirmed.");
}

export function runtimeEventBase(session: V2RuntimeSession, id: string, created = Date.now()) {
  return {
    provider: "opencodeV2" as const,
    threadId: session.threadId,
    sessionEpoch: session.epoch,
    ...(session.row ? { turnId: session.row.turnId } : {}),
    eventId: EventId.makeUnsafe(`v2:${session.native.id}:${id}`),
    createdAt: new Date(created).toISOString(),
  };
}

/** Require exact admitted input, a single input interval, and a projected idle marker. */
export function correlatedProjection(
  session: V2RuntimeSession,
  messages: readonly SessionMessageInfo[],
) {
  const row = session.row;
  if (!row) return undefined;
  const index = messages.findIndex(
    (message) =>
      message.id === row.nativeAdmissionId &&
      message.type === "user" &&
      message.metadata?.bigbud_fingerprint === row.fingerprint,
  );
  if (index < 0) return undefined;
  const assistants: SessionMessageAssistant[] = [];
  for (const message of messages.slice(index + 1)) {
    if (["user", "synthetic", "shell", "skill"].includes(message.type)) return undefined;
    if (message.type === "assistant") assistants.push(message);
    if (message.type === "idle") return { assistants, idle: message };
  }
  return { assistants, idle: undefined };
}

export function usageEvent(
  session: V2RuntimeSession,
  message: SessionMessageAssistant,
): ProviderRuntimeEvent | undefined {
  const tokens: TokenUsageInfo | undefined = message.tokens;
  if (
    !tokens ||
    ![tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    return undefined;
  const processed = tokens.input + tokens.output + tokens.cache.read + tokens.cache.write;
  if (!Number.isSafeInteger(processed)) return undefined;
  const finalized = isV2AssistantSettled(message) && !message.retry;
  const signature = createHash("sha256")
    .update(JSON.stringify([tokens, finalized]))
    .digest("hex");
  return {
    ...runtimeEventBase(session, `usage:${message.id}:${signature}`),
    type: "thread.token-usage.updated",
    payload: {
      usage: {
        usedTokens: processed,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cachedInputTokens: tokens.cache.read,
        reasoningOutputTokens: tokens.reasoning,
      },
      accounting: {
        scope: "item",
        scopeId: message.id,
        processedTokens: processed,
        inputTokens: tokens.input,
        cachedInputTokens: tokens.cache.read,
        outputTokens: tokens.output,
        reasoningOutputTokens: tokens.reasoning,
        finalized,
      },
    },
  };
}

export function projectionEvents(
  session: V2RuntimeSession,
  assistants: readonly SessionMessageAssistant[],
): ProviderRuntimeEvent[] {
  const events: ProviderRuntimeEvent[] = [];
  if (!session.row) return events;
  for (const message of assistants) {
    const usage = usageEvent(session, message);
    if (usage) events.push(usage);
    for (const part of message.content) {
      if (part.type !== "tool") continue;
      const itemId = RuntimeItemId.makeUnsafe(`${message.id}:tool:${part.id}`);
      const completed = part.state.status === "completed" || part.state.status === "error";
      const signature = createHash("sha256").update(JSON.stringify(part.state)).digest("hex");
      const started = runtimeEventBase(session, `tool-start:${message.id}:${part.id}`);
      const detail =
        part.state.status === "error"
          ? part.state.error.message
          : part.state.status === "completed"
            ? part.state.content
                .filter((content) => content.type === "text")
                .map((content) => content.text)
                .join("\n")
            : undefined;
      events.push({
        ...(completed || session.emitted.has(started.eventId)
          ? runtimeEventBase(session, `tool:${message.id}:${part.id}:${signature}`)
          : started),
        itemId,
        type: completed
          ? "item.completed"
          : session.emitted.has(started.eventId)
            ? "item.updated"
            : "item.started",
        payload: {
          itemType: "dynamic_tool_call",
          title: part.name,
          status: part.state.status === "error" ? "failed" : completed ? "completed" : "inProgress",
          ...(detail ? { detail } : {}),
          data: { name: part.name, ...part.state },
        },
      });
    }
    if (!isV2AssistantSettled(message) || message.retry) continue;
    const final = authoritativeAssistantRepair({
      admission: session.row,
      message,
      nativeSessionId: session.native.id,
      location: session.native.location.directory,
      sessionEpoch: session.epoch,
      isCurrent: !session.stopped,
      correlationProven: true,
    });
    if (final) events.push(final);
    else {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text && text.length <= 2000000 && !message.retry)
        events.push({
          ...runtimeEventBase(session, `failed-final:${message.id}`),
          itemId: RuntimeItemId.makeUnsafe(message.id),
          type: "item.completed",
          payload: { itemType: "assistant_message", status: "failed", detail: text },
        });
    }
    const reasoning = message.content
      .filter((part) => part.type === "reasoning")
      .map((part) => part.text)
      .join("");
    if (reasoning && !message.retry)
      events.push({
        ...runtimeEventBase(session, `reasoning:${message.id}`),
        itemId: RuntimeItemId.makeUnsafe(`${message.id}:reasoning`),
        type: "item.completed",
        payload: { itemType: "reasoning", status: "completed", detail: reasoning },
      });
  }
  return events;
}
