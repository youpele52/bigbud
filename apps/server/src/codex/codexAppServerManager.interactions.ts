import { randomUUID } from "node:crypto";
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
} from "@bigbud/contracts";
import type {
  CodexSessionContext,
  PendingApprovalRequest,
  PendingUserInputRequest,
} from "./codexAppServerManager.types.ts";
import type { TurnOps } from "./codexAppServerManager.turn.ts";
import { CodexRpcError } from "./codexAppServerManager.errors.ts";
import { toCodexUserInputAnswers } from "./codexAppServerManager.utils.ts";

/** A queued response is not yet sent; only proved non-delivery permits a manual retry. */
async function writeInteractionResponse(
  context: CodexSessionContext,
  pending: PendingApprovalRequest | PendingUserInputRequest,
  result: unknown,
  ops: TurnOps,
): Promise<boolean> {
  if (pending.responding || pending.state === "response-sent-unconfirmed") {
    throw new Error(
      "Codex interaction response was already submitted; its native resolution is unconfirmed.",
    );
  }
  if (pending.epoch !== undefined && pending.epoch !== context.session.sessionEpoch) {
    throw new Error("Codex interaction belongs to a different process epoch.");
  }
  const epoch = context.session.sessionEpoch;
  const {
    requestId,
    jsonRpcId,
    nativeThreadId,
    nativeTurnId,
    itemId,
    epoch: requestEpoch,
  } = pending;
  const requests = "requestKind" in pending ? context.pendingApprovals : context.pendingUserInputs;
  const isCurrent = () =>
    !context.stopping &&
    context.session.sessionEpoch === epoch &&
    requests.get(requestId) === pending &&
    pending.epoch === requestEpoch &&
    pending.jsonRpcId === jsonRpcId &&
    pending.nativeThreadId === nativeThreadId &&
    pending.nativeTurnId === nativeTurnId &&
    pending.itemId === itemId;
  let dispatched = false;
  pending.responding = true;
  try {
    await ops.writeMessage(
      context,
      { id: jsonRpcId, result },
      {
        shouldDispatch: isCurrent,
        onDispatch: () => {
          dispatched = true;
        },
      },
    );
    if (!dispatched) return false;
    pending.state = "response-sent-unconfirmed";
    return isCurrent();
  } catch (cause) {
    pending.state =
      cause instanceof CodexRpcError && cause.delivery === "not-dispatched"
        ? "pending"
        : "response-sent-unconfirmed";
    throw cause;
  } finally {
    pending.responding = false;
  }
}

export async function respondToRequest(
  context: CodexSessionContext,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  ops: TurnOps,
): Promise<void> {
  const pendingRequest = context.pendingApprovals.get(requestId);
  if (!pendingRequest) throw new Error(`Unknown pending approval request: ${requestId}`);
  if (!(await writeInteractionResponse(context, pendingRequest, { decision }, ops))) return;
  pendingRequest.uiClosed = true;
  ops.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: "notification",
    provider: "codex",
    threadId: context.session.threadId,
    sessionEpoch: context.session.sessionEpoch!,
    createdAt: new Date().toISOString(),
    method: "item/requestApproval/decision",
    turnId: pendingRequest.turnId,
    itemId: pendingRequest.itemId,
    requestId: pendingRequest.requestId,
    requestKind: pendingRequest.requestKind,
    payload: {
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      decision,
    },
  });
}

export async function respondToUserInput(
  context: CodexSessionContext,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  ops: TurnOps,
): Promise<void> {
  const pendingRequest = context.pendingUserInputs.get(requestId);
  if (!pendingRequest) throw new Error(`Unknown pending user input request: ${requestId}`);
  const codexAnswers = toCodexUserInputAnswers(answers);
  if (!(await writeInteractionResponse(context, pendingRequest, { answers: codexAnswers }, ops)))
    return;
  pendingRequest.uiClosed = true;
  ops.emitEvent({
    id: EventId.makeUnsafe(randomUUID()),
    kind: "notification",
    provider: "codex",
    threadId: context.session.threadId,
    sessionEpoch: context.session.sessionEpoch!,
    createdAt: new Date().toISOString(),
    method: "item/tool/requestUserInput/answered",
    turnId: pendingRequest.turnId,
    itemId: pendingRequest.itemId,
    requestId: pendingRequest.requestId,
    payload: { requestId: pendingRequest.requestId, answers: codexAnswers },
  });
}
