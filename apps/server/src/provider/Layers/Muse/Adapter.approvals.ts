import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";

import type { MuseApprovalRequestParams } from "./Client.schema.ts";
import type { MusePendingApproval } from "./Adapter.types.ts";

/** Stage-specific canonical request identity: an old click cannot approve a new stage. */
export function museApprovalRequestId(params: MuseApprovalRequestParams): string {
  return `${params.approvalId}:${params.currentRequirementId.sourceIndex}`;
}

export function toPendingApproval(params: MuseApprovalRequestParams): MusePendingApproval {
  return {
    approvalId: params.approvalId,
    sessionId: params.sessionId,
    turnId: params.turnId,
    requirementId: params.currentRequirementId,
    choices: params.availableChoices,
    requestId: museApprovalRequestId(params),
  };
}

export function approvalSubjectSummary(params: MuseApprovalRequestParams): string {
  const subject = params.subject;
  if (subject.kind === "shell" && subject.command) return subject.command.slice(0, 300);
  if (subject.path) return `${subject.kind}: ${subject.path}`.slice(0, 300);
  return `${subject.kind}: ${params.toolName}`.slice(0, 300);
}

export function requestTypeForApproval(params: MuseApprovalRequestParams): string {
  switch (params.subject.kind) {
    case "shell":
      return "command_execution_approval";
    case "fileAccess":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

/**
 * Map a native approval presentation to the canonical request.opened event.
 * The server-request receipt itself grants nothing; the decision travels as
 * a separate approval/decide command (see Adapter.respondToRequest).
 * `acceptForSession` is offered only when a native session-scope choice
 * exists; a localPersistent ("always allow") choice is never mapped to it.
 */
export function mapApprovalOpened(
  threadId: ThreadId,
  params: MuseApprovalRequestParams,
): ProviderRuntimeEvent {
  const sessionChoice = params.availableChoices.find(
    (choice) => choice.scope === "session" && choice.decision === "approvedForSession",
  );
  return {
    eventId: `muse-approval-${params.approvalId}-${params.currentRequirementId.sourceIndex}`,
    provider: "muse",
    threadId,
    createdAt: new Date().toISOString(),
    turnId: params.turnId as TurnId,
    requestId: museApprovalRequestId(params),
    type: "request.opened",
    payload: {
      requestType: requestTypeForApproval(params),
      detail: approvalSubjectSummary(params),
      args: {
        toolName: params.toolName,
        subject: params.subject,
        choices: params.availableChoices.map((choice) => ({
          choiceId: choice.choiceId,
          label: choice.label,
          scope: choice.scope,
          ...(choice.rulePreview ? { rulePreview: choice.rulePreview } : {}),
        })),
      },
      sessionApprovalAvailable: sessionChoice !== undefined,
      ...(sessionChoice ? { sessionApprovalLabel: sessionChoice.label } : {}),
    },
  } as ProviderRuntimeEvent;
}

/**
 * Resolve a canonical decision to one of the choices the server offered.
 * Unknown/forbidden scopes resolve to undefined (refuse, never auto-approve).
 */
export function choiceForDecision(
  pending: MusePendingApproval,
  decision: ProviderApprovalDecision,
): string | undefined {
  const choices = pending.choices;
  switch (decision) {
    case "accept":
      return choices.find((c) => c.decision === "approved" && c.scope === "once")?.choiceId;
    case "acceptForSession":
      return choices.find((c) => c.decision === "approvedForSession" && c.scope === "session")
        ?.choiceId;
    case "decline":
      return choices.find((c) => c.decision === "denied")?.choiceId;
    case "cancel":
      return (
        choices.find((c) => c.decision === "abort")?.choiceId ??
        choices.find((c) => c.decision === "denied")?.choiceId
      );
  }
}

import type { MuseAdapterShape } from "../../Services/Muse/Adapter.ts";
import { museValidationError } from "./Client.errors.ts";
import type { MuseAdapterContext } from "./Adapter.types.ts";
import { Effect } from "effect";
import { mapMuseRequestError } from "./Client.errors.ts";
import { resolveMuseApproval, validateMuseAck } from "./Adapter.interactions.ts";
import { stampMuseEvent } from "./Adapter.sessionView.ts";

/**
 * Decide a pending Muse approval with only an offered choice, the current
 * native requirement identity and a stable command ID. Stage identities are
 * retired as they settle; a further stage arrives as a fresh request.
 */
export const makeMuseApprovalResponder = (
  ctx: MuseAdapterContext,
): MuseAdapterShape["respondToRequest"] =>
  Effect.fn("Muse.respondToRequest")(function* (threadId, requestId, decision) {
    const session = yield* ctx.getSession(threadId);
    const pending = session.pendingApprovals.get(String(requestId));
    if (!pending) {
      return yield* museValidationError(
        "respondToRequest",
        "Muse approval request is stale or unknown.",
        "invalid-request",
      );
    }
    const choiceId = choiceForDecision(pending, decision);
    if (!choiceId) {
      return yield* museValidationError(
        "respondToRequest",
        `Muse did not offer a choice for decision '${decision}' at this approval stage.`,
        "invalid-request",
      );
    }
    const cid = session.transport.mintCommandId();
    const raw = yield* Effect.tryPromise({
      try: () =>
        session.transport.command(
          "approval/decide",
          {
            commandId: cid,
            sessionId: pending.sessionId,
            approvalId: pending.approvalId,
            choiceId,
            requirementId: pending.requirementId,
          },
          cid,
        ),
      catch: (error) => mapMuseRequestError("approval/decide", error, "unsafe-to-replay"),
    });
    // terminal:false means a further stage follows as a fresh request; the
    // settled stage identity is retired either way.
    yield* Effect.try({
      try: () => validateMuseAck(raw, "approval/decide", cid, { approvalId: pending.approvalId }),
      catch: (cause) => mapMuseRequestError("approval/decide", cause, "unsafe-to-replay"),
    });
    const event = resolveMuseApproval(session, String(requestId), decision);
    if (event) yield* ctx.publish(stampMuseEvent(event, session.sessionEpoch));
  });
