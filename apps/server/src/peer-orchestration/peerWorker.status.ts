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

function childState(thread: OrchestrationThread): {
  readonly state: PeerChildState;
  readonly workflowStatus: string;
} {
  if (thread.deletedAt !== null) return { state: "failed", workflowStatus: "deleted" };
  const status = resolveThreadWorkflowStatus(thread);
  const turn = thread.latestTurn?.state ?? null;
  if (status.isAgentActive) return { state: "running", workflowStatus: status.workflowStatus };
  if (status.workflowStatus === "workflow_complete" || status.workflowStatus === "plan_ready")
    return { state: "completed", workflowStatus: status.workflowStatus };
  if (status.workflowStatus === "error" || turn === "error")
    return { state: "failed", workflowStatus: status.workflowStatus };
  if (status.hasPendingApprovals || status.hasPendingUserInput)
    return { state: "waiting", workflowStatus: status.workflowStatus };
  if (turn === "interrupted") return { state: "cancelled", workflowStatus: status.workflowStatus };
  if (status.workflowStatus === "archived" && turn === "completed")
    return { state: "completed", workflowStatus: status.workflowStatus };
  return { state: "running", workflowStatus: status.workflowStatus };
}

export function peerChildStatus(child: PeerChild, thread: OrchestrationThread): PeerChildStatus {
  const { state, workflowStatus } = childState(thread);
  const text = lastAssistantText(thread);
  const result = !isTerminalPeerChildState(state)
    ? null
    : boundPeerSummary(
        state === "completed" ? "completed" : state === "failed" ? "failed" : "cancelled",
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
