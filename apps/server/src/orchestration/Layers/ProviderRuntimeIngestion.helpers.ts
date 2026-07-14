/**
 * ProviderRuntimeIngestion helpers — pure utility functions, constants, and
 * event-to-activity mapping used by the ingestion pipeline.
 *
 * @module ProviderRuntimeIngestion.helpers
 */
import {
  ApprovalRequestId,
  type OrchestrationEvent,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ProviderKind,
  type ProviderInteractionMode,
  type ThreadTokenUsageAccounting,
  type ThreadTokenUsageSnapshot,
} from "@bigbud/contracts";

import { runtimeEventToActivitiesFromHelpers } from "./ProviderRuntimeIngestion.helpers.activities.ts";

export const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
export const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
export const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
export const STRICT_PROVIDER_LIFECYCLE_GUARD =
  (process.env.BIGBUD_STRICT_PROVIDER_LIFECYCLE_GUARD ??
    process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD) !== "0";

export type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

export type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

export function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

export function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

export function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

export function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

export function normalizeProposedPlanMarkdown(
  planMarkdown: string | undefined,
): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export function proposedPlanIdForTurn(threadId: string, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

export function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: string): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

type ContextWindowActivityPayload = ThreadTokenUsageSnapshot & {
  readonly accounting?: ThreadTokenUsageAccounting & {
    readonly provider: ProviderKind;
    readonly model: string;
    readonly interactionMode: ProviderInteractionMode;
  };
};

export interface UsageActivityAttribution {
  readonly model: string;
  readonly interactionMode: ProviderInteractionMode;
}

export function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
  attribution?: UsageActivityAttribution,
): ContextWindowActivityPayload | undefined {
  if (
    event.type !== "thread.token-usage.updated" ||
    (event.payload.usage.usedTokens <= 0 && (event.payload.accounting?.processedTokens ?? 0) <= 0)
  ) {
    return undefined;
  }
  return {
    ...event.payload.usage,
    ...(event.payload.accounting && attribution
      ? {
          accounting: {
            ...event.payload.accounting,
            provider: event.provider,
            model: attribution.model,
            interactionMode: attribution.interactionMode,
          },
        }
      : {}),
  };
}

export function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

export function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

export function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "browser" | "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "browser_approval":
      return "browser";
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  usageAttribution?: UsageActivityAttribution,
): ReadonlyArray<OrchestrationThreadActivity> {
  return runtimeEventToActivitiesFromHelpers(event, {
    toTurnId,
    toApprovalRequestId,
    truncateDetail,
    requestKindFromCanonicalRequestType,
    buildContextWindowActivityPayload: (runtimeEvent) =>
      buildContextWindowActivityPayload(runtimeEvent, usageAttribution),
  });
}
