/**
 * OpencodeAdapter stream event mapping — maps OpenCode SSE events to
 * canonical ProviderRuntimeEvents.
 *
 * @module OpencodeAdapter.stream.mapEvent
 */
import { randomUUID } from "node:crypto";
import {
  EventId,
  TurnId,
  type ProviderRuntimeEvent,
  type ThreadTokenUsageSnapshot,
  type UserInputQuestion,
} from "@bigbud/contracts";
import { type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import { FULL_ACCESS_AUTO_APPROVE_AFTER_MS } from "@bigbud/shared/approvals";

import type { ActiveOpencodeSession } from "./OpencodeAdapter.types.ts";
import {
  eventBase,
  normalizeString,
  requestDetailFromPermission,
  requestTypeFromPermission,
} from "./OpencodeAdapter.stream.utils.ts";

export { FULL_ACCESS_AUTO_APPROVE_AFTER_MS };

function statusMessageLooksLikeCompaction(message: string | undefined): boolean {
  return typeof message === "string" && /compact/i.test(message);
}

/**
 * Stable key for correlating a question answer back to its question by index.
 * Mirrors the t3code `openCodeQuestionId` helper.
 */
export function openCodeQuestionId(index: number, header: string): string {
  return `${index}-${header
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")}`;
}

/**
 * Shared logic for handling an OpenCode "session idle" transition, emitted
 * either via `session.status { type: "idle" }` or the top-level `session.idle`
 * event. Clears the active turn and emits a `turn.completed` +
 * `session.state.changed(ready)` pair.
 */
function handleSessionIdle(
  session: ActiveOpencodeSession,
  turnId: TurnId | undefined,
  stamp: { eventId: EventId; createdAt: string },
  raw: { source: "opencode.sdk.session-event"; method: string; payload: unknown },
  nextEventId: Effect.Effect<EventId>,
  createdAt: string,
): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> {
  return Effect.gen(function* () {
    const completedTurnId = turnId;
    session.activeTurnId = undefined;
    session.wasRetrying = false;
    session.turns.at(-1)?.items.push(raw);

    const readyEventId = yield* nextEventId;
    const events: ProviderRuntimeEvent[] = [
      {
        ...eventBase({
          eventId: stamp.eventId,
          createdAt,
          threadId: session.threadId,
          ...(completedTurnId ? { turnId: completedTurnId } : {}),
          raw,
        }),
        type: "turn.completed",
        payload: {
          state: "completed",
          ...(session.lastUsage ? { usage: session.lastUsage } : {}),
        },
      },
      {
        ...eventBase({
          eventId: readyEventId,
          createdAt,
          threadId: session.threadId,
          raw,
        }),
        type: "session.state.changed",
        payload: { state: "ready", reason: "session.idle" },
      },
    ];
    return events;
  });
}

/**
 * Map an OpenCode SSE event to zero or more ProviderRuntimeEvents.
 */
export function makeMapEvent(
  nextEventId: Effect.Effect<EventId>,
  makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>,
) {
  return (
    session: ActiveOpencodeSession,
    event: OpencodeEvent,
  ): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> =>
    Effect.gen(function* () {
      const turnId = session.activeTurnId;
      const stamp = yield* makeEventStamp();
      const createdAt = stamp.createdAt;
      const eventType = (event as { type: string }).type;
      const raw = {
        source: "opencode.sdk.session-event" as const,
        method: eventType,
        payload: event,
      };

      if (eventType === "message.part.delta") {
        const partDelta = event as OpencodeEvent & {
          properties: {
            partID?: string;
            field?: string;
            delta?: string;
          };
        };
        const delta = partDelta.properties.delta;
        const itemId = partDelta.properties.partID;

        if (!delta || !itemId) {
          return [];
        }

        const streamKind =
          partDelta.properties.field === "text"
            ? "assistant_text"
            : partDelta.properties.field === "reasoning"
              ? "reasoning_text"
              : undefined;

        if (!streamKind) {
          return [];
        }

        return [
          {
            ...eventBase({
              eventId: stamp.eventId,
              createdAt,
              threadId: session.threadId,
              ...(turnId ? { turnId } : {}),
              itemId,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind,
              delta,
            },
          },
        ];
      }

      switch (eventType) {
        case "message.part.updated": {
          const part = (event.properties as { part: { id: string; type: string } }).part;
          if (part.type === "tool") {
            const toolPart = part as unknown as {
              id: string;
              type: "tool";
              tool: string;
              state: {
                status?: string;
                input?: unknown;
                output?: string;
                error?: string;
                metadata?: Record<string, unknown>;
                title?: string;
              };
              metadata?: Record<string, unknown>;
            };

            const toolState = toolPart.state?.status;
            const toolInput = toolPart.state?.input;
            const toolOutput = normalizeString(toolPart.state?.output);
            const toolError = normalizeString(toolPart.state?.error);
            const toolTitle =
              normalizeString(toolPart.state?.title) ??
              normalizeString(toolPart.metadata?.title) ??
              toolPart.tool;

            if (toolState === "pending" || toolState === "running") {
              return [
                {
                  ...eventBase({
                    eventId: stamp.eventId,
                    createdAt,
                    threadId: session.threadId,
                    ...(turnId ? { turnId } : {}),
                    itemId: toolPart.id,
                    raw,
                  }),
                  type: "item.started",
                  payload: {
                    itemType: "dynamic_tool_call",
                    status: "inProgress",
                    title: toolTitle,
                    ...(toolInput ? { data: toolInput } : {}),
                  },
                },
              ];
            }

            if (toolState === "completed" || toolState === "error") {
              return [
                {
                  ...eventBase({
                    eventId: stamp.eventId,
                    createdAt,
                    threadId: session.threadId,
                    ...(turnId ? { turnId } : {}),
                    itemId: toolPart.id,
                    raw,
                  }),
                  type: "item.completed",
                  payload: {
                    itemType: "dynamic_tool_call",
                    status: toolState === "completed" ? "completed" : "failed",
                    title: toolTitle,
                    ...(toolOutput ? { detail: toolOutput } : {}),
                    ...(toolError ? { detail: toolError } : {}),
                    data: toolPart,
                  },
                },
              ];
            }

            return [];
          }

          return [];
        }
        case "message.updated": {
          const msg = (event.properties as { info: { role: string } }).info;
          if (msg.role !== "assistant") return [];

          const assistantMsg = msg as {
            id: string;
            role: "assistant";
            modelID?: string;
            providerID?: string;
            tokens?: {
              input: number;
              output: number;
              reasoning: number;
              cache: { read: number; write: number };
            };
            cost?: number;
            time?: { completed?: number };
          };

          // Track model info
          if (assistantMsg.modelID) {
            session.model = assistantMsg.modelID;
          }
          if (assistantMsg.providerID) {
            session.providerID = assistantMsg.providerID;
          }

          // Emit token usage if available
          if (assistantMsg.tokens) {
            const tokens = assistantMsg.tokens;
            const inputTokens = tokens.input ?? 0;
            const outputTokens = tokens.output ?? 0;
            const cachedInputTokens = tokens.cache?.read ?? 0;
            const usedTokens = inputTokens + outputTokens + cachedInputTokens;

            if (usedTokens > 0) {
              const usage: ThreadTokenUsageSnapshot = {
                usedTokens,
                totalProcessedTokens: usedTokens,
                ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
                ...(cachedInputTokens > 0
                  ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
                  : {}),
                ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
                ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
              };
              session.lastUsage = usage;

              return [
                {
                  ...eventBase({
                    eventId: stamp.eventId,
                    createdAt,
                    threadId: session.threadId,
                    ...(turnId ? { turnId } : {}),
                    itemId: assistantMsg.id,
                    raw,
                  }),
                  type: "thread.token-usage.updated",
                  payload: { usage },
                },
              ];
            }
          }

          // If the message is complete (has completion time), emit item.completed
          if (assistantMsg.time?.completed) {
            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(turnId ? { turnId } : {}),
                  itemId: assistantMsg.id,
                  raw,
                }),
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  title: "Assistant message",
                  data: assistantMsg,
                },
              },
            ];
          }

          return [];
        }

        case "session.status": {
          const status = (
            event.properties as {
              status: { type: string; message?: string };
            }
          ).status;

          if (status.type === "busy") {
            const existingTurnId = session.activeTurnId;
            if (existingTurnId) {
              if (statusMessageLooksLikeCompaction(status.message)) {
                session.wasRetrying = false;
                const compactionEventId = yield* nextEventId;
                return [
                  {
                    ...eventBase({
                      eventId: compactionEventId,
                      createdAt,
                      threadId: session.threadId,
                      ...(existingTurnId ? { turnId: existingTurnId } : {}),
                      raw,
                    }),
                    type: "session.state.changed",
                    payload: { state: "waiting", reason: "context.compacting", detail: status },
                  },
                ];
              }

              // If we were in a waiting/retry state, transition back to running.
              if (session.wasRetrying) {
                session.wasRetrying = false;
                const resumeEventId = yield* nextEventId;
                return [
                  {
                    ...eventBase({
                      eventId: resumeEventId,
                      createdAt,
                      threadId: session.threadId,
                      ...(existingTurnId ? { turnId: existingTurnId } : {}),
                      raw,
                    }),
                    type: "session.state.changed",
                    payload: { state: "running", reason: "session.retry.resumed" },
                  },
                ];
              }
              session.turns.at(-1)?.items.push(event);
              return [];
            }

            const newTurnId = TurnId.makeUnsafe(`opencode-turn-${randomUUID()}`);
            session.activeTurnId = newTurnId;
            session.turns.push({ id: newTurnId, items: [event] });

            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  turnId: newTurnId,
                  raw,
                }),
                type: "turn.started",
                payload: session.model ? { model: session.model } : {},
              },
            ];
          }

          if (status.type === "idle") {
            return yield* handleSessionIdle(session, turnId, stamp, raw, nextEventId, createdAt);
          }

          if (status.type === "retry") {
            // OpenCode is waiting to retry (e.g. rate-limited). Surface this in
            // the UI as a "waiting" state so the user sees a meaningful status
            // instead of the spinner hanging indefinitely.
            session.wasRetrying = true;
            const retryStatus = status as { type: "retry"; message?: string; next?: number };
            const reason = retryStatus.message
              ? `Retrying: ${retryStatus.message}`
              : "session.retry.waiting";
            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(turnId ? { turnId } : {}),
                  raw,
                }),
                type: "session.state.changed",
                payload: { state: "waiting", reason },
              },
            ];
          }

          return [];
        }

        case "session.idle": {
          // Top-level session.idle event — treat identically to
          // session.status { type: "idle" }.
          return yield* handleSessionIdle(session, turnId, stamp, raw, nextEventId, createdAt);
        }

        case "session.compacted": {
          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                raw,
              }),
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: event.properties,
              },
            },
          ];
        }

        case "permission.asked": {
          const permission = event.properties as {
            id: string;
            sessionID: string;
            permission: string;
            patterns: Array<string>;
            always: Array<string>;
            metadata: Record<string, unknown>;
            tool?: { messageID: string; callID: string };
          };

          if (!session.pendingPermissions.has(permission.id)) {
            const reqType = requestTypeFromPermission(permission);
            session.pendingPermissions.set(permission.id, {
              requestType: reqType,
              turnId,
              requestId: permission.id,
              responding: false,
            });

            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(turnId ? { turnId } : {}),
                  requestId: permission.id,
                  raw,
                }),
                type: "request.opened",
                payload: {
                  requestType: reqType,
                  ...(requestDetailFromPermission(permission)
                    ? { detail: requestDetailFromPermission(permission) }
                    : {}),
                  args: permission,
                  ...(session.runtimeMode === "full-access"
                    ? { autoApproveAfterMs: FULL_ACCESS_AUTO_APPROVE_AFTER_MS }
                    : {}),
                },
              },
            ];
          }
          return [];
        }

        case "question.asked": {
          const questionReq = event.properties as {
            id: string;
            sessionID: string;
            questions: Array<{
              question: string;
              header: string;
              options: Array<{ label: string; description: string }>;
              multiple?: boolean;
              custom?: boolean;
            }>;
            tool?: { messageID: string; callID: string };
          };

          if (!session.pendingUserInputs.has(questionReq.id)) {
            session.pendingUserInputs.set(questionReq.id, {
              turnId,
              questions: questionReq.questions,
            });

            const userInputQuestions: UserInputQuestion[] = questionReq.questions.map(
              (q, index) => ({
                id: openCodeQuestionId(index, q.header),
                header: q.header,
                question: q.question,
                options: q.options,
                ...(q.multiple !== undefined ? { multiple: q.multiple } : {}),
                ...(q.custom !== undefined ? { custom: q.custom } : {}),
              }),
            );

            return [
              {
                ...eventBase({
                  eventId: stamp.eventId,
                  createdAt,
                  threadId: session.threadId,
                  ...(turnId ? { turnId } : {}),
                  requestId: questionReq.id,
                  raw,
                }),
                type: "user-input.requested",
                payload: { questions: userInputQuestions },
              },
            ];
          }
          return [];
        }

        case "question.replied":
        case "question.rejected": {
          const qProps = event.properties as { sessionID: string; requestID: string };
          session.pendingUserInputs.delete(qProps.requestID);
          return [];
        }

        case "mcp.browser.open.failed": {
          const browserProps = event.properties as {
            mcpName: string;
            url: string;
          };
          const errorMessage = `Browser open failed for ${browserProps.mcpName}: ${browserProps.url}`;
          session.lastError = errorMessage;

          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                raw,
              }),
              type: "runtime.error",
              payload: {
                message: errorMessage,
                class: "browser_error",
                detail: { mcpName: browserProps.mcpName, url: browserProps.url },
              },
            },
          ];
        }

        case "session.error": {
          const errProps = event.properties as {
            sessionID?: string;
            error?: {
              name?: string;
              data?: {
                message?: string;
                responseBody?: string;
                statusCode?: number;
              };
            };
          };
          const errorMessage =
            errProps.error?.data?.message ?? errProps.error?.name ?? "Unknown OpenCode error";
          session.lastError = errorMessage;

          const detail = {
            ...(errProps.error?.name ? { name: errProps.error.name } : {}),
            ...(errProps.error?.data?.message ? { message: errProps.error.data.message } : {}),
            ...(errProps.error?.data?.responseBody
              ? { responseBody: errProps.error.data.responseBody }
              : {}),
            ...(typeof errProps.error?.data?.statusCode === "number"
              ? { statusCode: errProps.error.data.statusCode }
              : {}),
          };

          return [
            {
              ...eventBase({
                eventId: stamp.eventId,
                createdAt,
                threadId: session.threadId,
                ...(turnId ? { turnId } : {}),
                raw,
              }),
              type: "runtime.error",
              payload: {
                message: errorMessage,
                class: "provider_error",
                ...(Object.keys(detail).length > 0 ? { detail } : {}),
              },
            },
          ];
        }

        default:
          return [];
      }
    });
}
