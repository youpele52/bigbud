/**
 * PendingApprovals projector — handles approval request and resolution events.
 *
 * @module ProjectionPipeline.projector.pendingApprovals
 */
import { type OrchestrationEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
  extractActivityRequestId,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

/**
 * Returns true if the failure detail string indicates the approval request was
 * already stale (i.e. the provider tried to respond to an approval that no
 * longer exists). These stale failures should resolve the pending approval row
 * rather than leave it dangling.
 */
function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

export function makePendingApprovalsProjector(
  deps: Pick<ProjectorDeps, "projectionPendingApprovalRepository">,
): ProjectorDefinition {
  const { projectionPendingApprovalRepository } = deps;

  const apply = Effect.fn("applyPendingApprovalsProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    switch (event.type) {
      case "thread.activity-appended": {
        const requestId =
          extractActivityRequestId(event.payload.activity.payload) ??
          event.metadata.requestId ??
          null;
        if (requestId === null) {
          return;
        }
        const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
          requestId,
        });
        if (event.payload.activity.kind === "approval.resolved") {
          const resolvedDecisionRaw =
            typeof event.payload.activity.payload === "object" &&
            event.payload.activity.payload !== null &&
            "decision" in event.payload.activity.payload
              ? (event.payload.activity.payload as { decision?: unknown }).decision
              : null;
          const resolvedDecision =
            resolvedDecisionRaw === "accept" ||
            resolvedDecisionRaw === "acceptForSession" ||
            resolvedDecisionRaw === "decline" ||
            resolvedDecisionRaw === "cancel"
              ? resolvedDecisionRaw
              : null;
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow)
              ? existingRow.value.turnId
              : event.payload.activity.turnId,
            status: "resolved",
            decision: resolvedDecision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: event.payload.activity.createdAt,
          });
          return;
        }
        if (event.payload.activity.kind === "provider.approval.respond.failed") {
          const payload =
            typeof event.payload.activity.payload === "object" &&
            event.payload.activity.payload !== null
              ? (event.payload.activity.payload as Record<string, unknown>)
              : null;
          const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
          if (isStalePendingApprovalFailureDetail(detail)) {
            if (Option.isNone(existingRow)) {
              return;
            }
            if (existingRow.value.status === "resolved") {
              return;
            }
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: existingRow.value.threadId,
              turnId: existingRow.value.turnId,
              status: "resolved",
              decision: null,
              createdAt: existingRow.value.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          return;
        }
        if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
          return;
        }
        yield* projectionPendingApprovalRepository.upsert({
          requestId,
          threadId: event.payload.threadId,
          turnId: event.payload.activity.turnId,
          status: "pending",
          decision: null,
          createdAt: Option.isSome(existingRow)
            ? existingRow.value.createdAt
            : event.payload.activity.createdAt,
          resolvedAt: null,
        });
        return;
      }

      case "thread.approval-response-requested": {
        const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
          requestId: event.payload.requestId,
        });
        yield* projectionPendingApprovalRepository.upsert({
          requestId: event.payload.requestId,
          threadId: Option.isSome(existingRow)
            ? existingRow.value.threadId
            : event.payload.threadId,
          turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
          status: "resolved",
          decision: event.payload.decision,
          createdAt: Option.isSome(existingRow)
            ? existingRow.value.createdAt
            : event.payload.createdAt,
          resolvedAt: event.payload.createdAt,
        });
        return;
      }

      default:
        return;
    }
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals, apply };
}
