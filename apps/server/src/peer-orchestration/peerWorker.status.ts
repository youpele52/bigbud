/**
 * Worker-side peer child status (WP-8B): maps a child thread onto the bounded peer wire shape.
 * Pure; the caller loads the thread and the `peer_children` record.
 *
 * @module peerWorker.status
 */
import type { OrchestrationThread } from "@bigbud/contracts";
import {
  PEER_RESULT_SUMMARY_MAX_CHARS,
  type PeerErrorCode,
  type PeerResultSummary,
} from "@bigbud/contracts/server/remotePeer.ts";
import type { PeerChildState, PeerChildStatus } from "@bigbud/contracts/server/remotePeer.wire.ts";
import { Schema } from "effect";

import { resolveThreadWorkflowStatus } from "../orchestration/ThreadWorkflowStatus.logic.ts";
import type { PeerChild } from "../persistence/Services/PeerChildren.ts";

/** A typed peer refusal; the route answers `{ error: { code, message } }`. */
export class PeerWorkerRefusal extends Schema.TaggedErrorClass<PeerWorkerRefusal>()(
  "PeerWorkerRefusal",
  { code: Schema.String, message: Schema.String },
) {
  static of(code: PeerErrorCode, message: string) {
    return new PeerWorkerRefusal({ code, message: message.slice(0, 1024) });
  }
}

export const peerCommandId = (coordinatorAuthorityId: string, dispatchId: string) =>
  `peer:${coordinatorAuthorityId}:${dispatchId}`;

const TERMINAL: ReadonlySet<PeerChildState> = new Set(["completed", "failed", "cancelled"]);
export const isTerminalPeerChildState = (state: PeerChildState) => TERMINAL.has(state);

function lastAssistantText(thread: OrchestrationThread): string | null {
  const message = thread.messages.findLast(
    (entry) => entry.role === "assistant" && !entry.streaming && entry.text.trim().length > 0,
  );
  return message ? message.text.trim() : null;
}

/** Bounded summary; never exceeds the contract limit and says when it was cut. */
export function boundPeerSummary(
  outcome: PeerResultSummary["outcome"],
  text: string,
): PeerResultSummary {
  const truncated = text.length > PEER_RESULT_SUMMARY_MAX_CHARS;
  return {
    outcome,
    summary: truncated ? text.slice(0, PEER_RESULT_SUMMARY_MAX_CHARS) : text,
    truncated,
    attachments: [],
  };
}

const PROVIDER_TURN_START_FAILED = "provider.turn.start.failed";
const NEVER_STARTED = "The child's first turn never started on the worker.";

/**
 * F-P8-1: the first turn was accepted (its user message exists) but never bound to a provider
 * turn, and nothing can still start it (no pending start gate, queued prompt or active session).
 * Returns the failure reason, or null when the child may still start.
 */
export function peerChildStartFailure(thread: OrchestrationThread): string | null {
  if (thread.latestTurn !== null) return null;
  if (thread.pendingTurnStart != null || (thread.queuedPrompts?.length ?? 0) > 0) return null;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return null;
  if (!thread.messages.some((message) => message.role === "user")) return null;
  const failure = thread.activities.findLast(
    (activity) => activity.kind === PROVIDER_TURN_START_FAILED,
  );
  const payload = failure?.payload as { readonly detail?: unknown } | undefined;
  const detail = typeof payload?.detail === "string" ? payload.detail.trim() : "";
  const reason = detail || thread.session?.lastError?.trim() || failure?.summary || "";
  return reason ? `${NEVER_STARTED} ${reason}` : NEVER_STARTED;
}

function childState(thread: OrchestrationThread): {
  readonly state: PeerChildState;
  readonly workflowStatus: string;
  readonly reason?: string;
} {
  if (thread.deletedAt !== null) return { state: "failed", workflowStatus: "deleted" };
  const status = resolveThreadWorkflowStatus(thread);
  const turn = thread.latestTurn?.state ?? null;
  if (status.isAgentActive) return { state: "running", workflowStatus: status.workflowStatus };
  if (status.workflowStatus === "workflow_complete" || status.workflowStatus === "plan_ready")
    return { state: "completed", workflowStatus: status.workflowStatus };
  const startFailure = peerChildStartFailure(thread);
  if (startFailure !== null)
    return { state: "failed", workflowStatus: status.workflowStatus, reason: startFailure };
  if (status.workflowStatus === "error" || turn === "error")
    return { state: "failed", workflowStatus: status.workflowStatus };
  if (status.hasPendingApprovals || status.hasPendingUserInput)
    return { state: "waiting", workflowStatus: status.workflowStatus };
  if (turn === "interrupted") return { state: "cancelled", workflowStatus: status.workflowStatus };
  if (status.workflowStatus === "archived" && turn === "completed")
    return { state: "completed", workflowStatus: status.workflowStatus };
  return { state: "running", workflowStatus: status.workflowStatus };
}

const resultOutcome = (state: PeerChildState) =>
  state === "completed" ? "completed" : state === "failed" ? "failed" : "cancelled";

export function peerChildStatus(child: PeerChild, thread: OrchestrationThread): PeerChildStatus {
  const { state, workflowStatus, reason } = childState(thread);
  const text = reason ?? lastAssistantText(thread);
  const result = !isTerminalPeerChildState(state)
    ? null
    : boundPeerSummary(
        resultOutcome(state),
        text ??
          (state === "completed"
            ? "The child finished without a final message."
            : state === "failed"
              ? "The child failed on the worker."
              : "The child was cancelled."),
      );
  return {
    dispatchId: child.dispatchId,
    commandId: child.commandId,
    childThreadId: thread.id,
    state,
    workflowStatus: workflowStatus.slice(0, 64),
    cancelRequested: child.cancelRequestedAt !== null,
    result,
  } as PeerChildStatus;
}

/**
 * Status of a child whose start intent is not complete (F-P8-3): `running` while the worker
 * still completes it, terminal once the start was refused or cancelled before the first turn.
 */
export function peerChildPendingStartStatus(
  child: PeerChild,
  cancelledReason: string,
): PeerChildStatus {
  const failure = child.startFailure;
  const state: PeerChildState =
    failure === null ? "running" : failure === cancelledReason ? "cancelled" : "failed";
  return {
    dispatchId: child.dispatchId,
    commandId: child.commandId,
    childThreadId: child.childThreadId,
    state,
    workflowStatus: failure === null ? "starting" : "not_started",
    cancelRequested: child.cancelRequestedAt !== null,
    result: failure === null ? null : boundPeerSummary(resultOutcome(state), failure),
  } as PeerChildStatus;
}
