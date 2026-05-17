/**
 * OpencodeAdapter stream event mapping — maps OpenCode SSE events to
 * canonical ProviderRuntimeEvents.
 *
 * @module OpencodeAdapter.stream.mapEvent
 */
import { EventId, type ProviderRuntimeEvent, type UserInputQuestion } from "@bigbud/contracts";
import { type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import { FULL_ACCESS_AUTO_APPROVE_AFTER_MS } from "@bigbud/shared/approvals";

import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import {
  mapMessagePartDelta,
  mapMessagePartUpdated,
  mapMessageUpdated,
} from "./Adapter.stream.mapEvent.messages.ts";
import { handleSessionIdle, handleSessionStatus } from "./Adapter.stream.mapEvent.status.ts";
import {
  eventBase,
  requestDetailFromPermission,
  requestTypeFromPermission,
} from "./Adapter.stream.utils.ts";

export { FULL_ACCESS_AUTO_APPROVE_AFTER_MS };

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

      const context = { stamp, raw, turnId };

      if (eventType === "message.part.delta") {
        return mapMessagePartDelta(session, event, context);
      }

      switch (eventType) {
        case "message.part.updated": {
          return mapMessagePartUpdated(session, event, context);
        }
        case "message.updated": {
          return mapMessageUpdated(session, event, context);
        }

        case "session.status": {
          const status = (
            event.properties as {
              status: { type: string; message?: string };
            }
          ).status;

          return yield* handleSessionStatus(session, status, turnId, stamp, raw, nextEventId);
        }

        case "session.idle": {
          // Top-level session.idle event — treat identically to
          // session.status { type: "idle" }.
          return yield* handleSessionIdle(session, turnId, stamp, raw, nextEventId);
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
