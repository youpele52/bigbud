import type { ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";
import { Option } from "effect";

import { describeMuseError, museRequestError } from "./Client.errors.ts";
import { decodeCommandAck } from "./Client.schema.ts";
import { museEventBase } from "./Adapter.stream.base.ts";
import type { MuseSessionState } from "./Adapter.types.ts";
import { museRecordedUserInputAnswers } from "./Adapter.questions.settlement.ts";

/** Admission is not turn completion; accept only an exact command/target acknowledgement. */
export function validateMuseAck(
  raw: unknown,
  method: string,
  commandId: string,
  target: { turnId?: string; approvalId?: string; userInputId?: string },
) {
  const ack = decodeCommandAck(raw);
  const record = raw as Record<string, unknown> | null;
  if (
    Option.isNone(ack) ||
    ack.value.commandId !== commandId ||
    ack.value.status !== "accepted" ||
    Object.entries(target).some(([key, value]) => record?.[key] !== value) ||
    (target.approvalId !== undefined && typeof ack.value.terminal !== "boolean")
  )
    throw museRequestError(
      method,
      "Muse command acknowledgement did not confirm its target.",
      "unsafe-to-replay",
      raw,
    );
}

/** Retire only the exact pending stage; repeated acknowledgements/notifications are idempotent. */
export function resolveMuseApproval(
  state: MuseSessionState,
  requestId: string,
  decision: string,
): ProviderRuntimeEvent | undefined {
  const pending = state.pendingApprovals.get(requestId);
  if (!pending || !state.pendingApprovals.delete(requestId)) return undefined;
  return {
    ...museEventBase(state.threadId, pending.turnId),
    requestId,
    type: "request.resolved",
    payload: { requestType: "unknown", decision },
  } as ProviderRuntimeEvent;
}

export function resolveMuseUserInput(
  state: MuseSessionState,
  requestId: string,
  answers: unknown,
): ProviderRuntimeEvent | undefined {
  if (!state.pendingUserInputs.delete(requestId)) return undefined;
  return {
    ...museEventBase(state.threadId),
    requestId,
    type: "user-input.resolved",
    payload: { answers },
  } as ProviderRuntimeEvent;
}

/** Notifications may resolve requests on another client; never infer resolution from transport loss. */
export function resolveMuseInteractionNotification(
  state: MuseSessionState,
  method: string,
  params: Record<string, unknown>,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (params.sessionId !== state.nativeSessionId) return [];
  if (
    method === "approval/resolved" &&
    typeof params.approvalId === "string" &&
    !!params.approvalId.trim() &&
    typeof params.decision === "string" &&
    !!params.decision.trim()
  ) {
    const decision =
      params.decision === "approvedForSession"
        ? "acceptForSession"
        : params.decision === "approved" || params.decision === "approvedPolicyAmendment"
          ? "accept"
          : params.decision === "abort"
            ? "cancel"
            : params.decision === "denied" ||
                params.decision === "deniedPolicyAmendment" ||
                params.decision === "timedOut"
              ? "decline"
              : describeMuseError(params.decision);
    return [...state.pendingApprovals.values()]
      .filter((entry) => entry.approvalId === params.approvalId)
      .flatMap((entry) => {
        const event = resolveMuseApproval(state, entry.requestId, decision);
        return event ? [event] : [];
      });
  }
  if (
    method === "userInput/settled" &&
    typeof params.userInputId === "string" &&
    !!params.userInputId.trim() &&
    typeof params.outcome === "string" &&
    !!params.outcome.trim()
  ) {
    if (!state.pendingUserInputs.has(params.userInputId)) return [];
    const answers = museRecordedUserInputAnswers(params);
    if (answers === undefined)
      return [
        museDiagnostic(
          state.threadId,
          "Malformed Muse user-input settlement; pending request retained.",
        ),
      ];
    const event = resolveMuseUserInput(state, params.userInputId, answers);
    return event ? [event] : [];
  }
  return [];
}

export function museDiagnostic(threadId: ThreadId, message: string): ProviderRuntimeEvent {
  return {
    ...museEventBase(threadId),
    type: "runtime.error",
    payload: { message, class: "provider_error" },
  } as ProviderRuntimeEvent;
}
