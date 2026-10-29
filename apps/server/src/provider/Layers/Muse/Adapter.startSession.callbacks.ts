import type { ProviderRuntimeEvent, ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { ProviderTurnAdmissionsShape } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { mapApprovalOpened, toPendingApproval } from "./Adapter.approvals.ts";
import { mapUserInputRequested } from "./Adapter.questions.ts";
import { settleMuseJournalTerminal } from "./Adapter.journal.ts";
import { mapMuseNotification, mapTerminalState } from "./Adapter.stream.ts";
import { museTerminalFromParams } from "./Adapter.stream.turns.ts";
import { setMuseActiveTurn } from "./Adapter.sessionView.ts";
import { trackMuseItem } from "./Adapter.stream.items.ts";
import {
  museDiagnostic,
  resolveMuseInteractionNotification,
  validateMuseAck,
} from "./Adapter.interactions.ts";
import type { MuseSessionState } from "./Adapter.types.ts";
import type { MuseNotification, MuseServerRequest } from "./Client.ts";
import { describeMuseError, mapMuseRequestError, museValidationError } from "./Client.errors.ts";
import { decodeApprovalRequest } from "./Client.schema.ts";
import { museUsageObservations, type MuseUsageObservations } from "./Usage.observations.ts";

const STARTUP_CALLBACK_LIMIT = 128;

/** Ordered, bounded startup buffering; a receipt is never returned for a dropped request. */
export function makeMuseHostCallbacks(input: {
  readonly threadId: ThreadId;
  readonly admissions: ProviderTurnAdmissionsShape | undefined;
  readonly getState: () => MuseSessionState | undefined;
  readonly emit: (event: ProviderRuntimeEvent) => void;
  readonly observations?: MuseUsageObservations;
}) {
  const { emit } = input;
  let ready = false;
  let failed: unknown;
  const queue: Array<{ run: () => Promise<void>; reject: (cause: unknown) => void }> = [];
  const bufferedRequests = new Set<(cause: unknown) => void>();
  // Only startup recovery candidates, never an unbounded history of live turns.
  const recoveredTurns = new Map<string, { event: ProviderRuntimeEvent; published: boolean }>();
  function publishRecovered(turnId: string, state: MuseSessionState) {
    const recovered = recoveredTurns.get(turnId);
    if (!recovered || recovered.published) return;
    recovered.published = true;
    state.queuedTurns.delete(turnId);
    if (state.activeTurnId === turnId) setMuseActiveTurn(state, undefined);
    state.lastSettledTurnId = turnId;
    state.updatedAt = new Date().toISOString();
    emit(recovered.event);
  }
  const diagnostic = (cause: unknown) =>
    emit(museDiagnostic(input.threadId, describeMuseError(cause)));
  function enqueue(run: () => Promise<void>, reject: (cause: unknown) => void) {
    if (failed) {
      reject(failed);
      return;
    }
    if (queue.length >= STARTUP_CALLBACK_LIMIT) {
      failed = museValidationError(
        "startupCallbacks",
        "Muse startup callback buffer exceeded its limit.",
        "unsafe-to-replay",
      );
      for (const pending of queue.splice(0)) pending.reject(failed);
      for (const rejectRequest of bufferedRequests) rejectRequest(failed);
      reject(failed);
      return;
    }
    queue.push({ run, reject });
  }
  function notification(n: MuseNotification) {
    try {
      if (n.method === "usage/changed") {
        (input.observations ?? museUsageObservations).record(n.params);
        return;
      }
      const state = input.getState();
      if (!state || state.closed || failed) return;
      const params = n.params ?? {};
      if (params.sessionId !== undefined && params.sessionId !== state.nativeSessionId) return;
      if (
        n.method.startsWith("turn/") &&
        (typeof params.turnId !== "string" || !params.turnId.trim())
      ) {
        diagnostic("Muse turn notification omitted its turn identity.");
        return;
      }
      const turnId = params.turnId as string;
      const terminal = n.method === "turn/completed" || n.method === "turn/unqueued";
      const recovered = recoveredTurns.get(turnId);
      if (recovered && (n.method === "turn/started" || terminal)) {
        // Durable recovery already proves this local turn settled. Preserve any
        // earlier start's canonical position, but never reopen local state or
        // emit a start/duplicate terminal after the recovered terminal.
        if (terminal) {
          trackMuseItem(state.items, n);
          publishRecovered(turnId, state);
        } else if (!recovered.published)
          for (const event of mapMuseNotification(input.threadId, n, state.items)) emit(event);
        return;
      }
      const outcome =
        n.method === "turn/unqueued"
          ? "interrupted"
          : mapTerminalState(museTerminalFromParams(params));
      if (n.method === "turn/started" || terminal) {
        for (const pending of state.inFlightStarts?.values() ?? []) {
          if (pending.observed.size < 64 || pending.observed.has(turnId)) {
            if (pending.observed.get(turnId) !== "started" && pending.observed.has(turnId))
              continue;
            pending.observed.set(turnId, terminal ? outcome : "started");
          } else pending.overflow = true;
        }
      }
      if (n.method === "turn/started") {
        state.queuedTurns.delete(turnId);
        if (state.lastSettledTurnId !== turnId) setMuseActiveTurn(state, turnId as TurnId);
      }
      if (terminal) {
        state.lastSettledTurnId = turnId;
        state.queuedTurns.delete(turnId);
        state.updatedAt = new Date().toISOString();
        if (state.activeTurnId === turnId) setMuseActiveTurn(state, undefined);
        const row = state.journalTurns.get(turnId);
        if (row && input.admissions) {
          Effect.runFork(
            settleMuseJournalTerminal(input.admissions, row, outcome).pipe(
              Effect.match({
                onFailure: diagnostic,
                onSuccess: (settled) => {
                  const tracked = state.journalTurns.get(turnId);
                  if (
                    tracked?.nativeAdmissionId === settled.nativeAdmissionId &&
                    tracked.revision <= settled.revision
                  )
                    state.journalTurns.delete(turnId);
                },
              }),
            ),
          );
        }
      }
      for (const event of resolveMuseInteractionNotification(state, n.method, params)) emit(event);
      const events = mapMuseNotification(input.threadId, n, state.items);
      trackMuseItem(state.items, n);
      for (const event of events) emit(event);
    } catch (cause) {
      diagnostic(cause);
    }
  }
  async function request(r: MuseServerRequest): Promise<Record<string, unknown>> {
    const state = input.getState();
    if (!state || state.closed || failed)
      throw museValidationError(
        "serverRequest",
        "Muse session is unavailable.",
        "provider-unavailable",
      );
    if (r.params?.sessionId !== undefined && r.params.sessionId !== state.nativeSessionId)
      throw museValidationError(
        "serverRequest",
        "Muse request targets a different session.",
        "invalid-request",
      );
    if (r.method === "approval/request") {
      const decoded = decodeApprovalRequest(r.params);
      if (
        Option.isNone(decoded) ||
        decoded.value.currentRequirementId.approvalId !== decoded.value.approvalId
      )
        throw museValidationError(
          "serverRequest",
          "Malformed Muse approval request.",
          "invalid-request",
        );
      const pending = toPendingApproval(decoded.value);
      state.pendingApprovals.set(pending.requestId, pending);
      emit(mapApprovalOpened(input.threadId, decoded.value));
      return {};
    }
    if (r.method === "userInput/request") {
      const params = r.params ?? {};
      if (typeof params.userInputId !== "string" || !params.userInputId.trim())
        throw museValidationError(
          "serverRequest",
          "Malformed Muse user-input identity.",
          "invalid-request",
        );
      const id = params.userInputId;
      state.pendingUserInputs.set(id, { requestId: id, sessionId: state.nativeSessionId, params });
      const event = mapUserInputRequested(input.threadId, params);
      if (event) emit(event);
      else {
        const cid = state.transport.mintCommandId();
        try {
          const raw = await state.transport.command(
            "userInput/cancel",
            { commandId: cid, sessionId: state.nativeSessionId, userInputId: id },
            cid,
          );
          validateMuseAck(raw, "userInput/cancel", cid, { userInputId: id });
          state.pendingUserInputs.delete(id);
        } catch (cause) {
          const error = mapMuseRequestError("userInput/cancel", cause, "unsafe-to-replay");
          diagnostic(error);
          throw error;
        }
      }
      return {};
    }
    throw museValidationError(
      "serverRequest",
      `Unsupported Muse server request '${r.method}'.`,
      "invalid-request",
    );
  }
  return {
    onNotification(n: MuseNotification) {
      if (ready || n.method === "usage/changed") notification(n);
      else
        enqueue(
          async () => notification(n),
          () => undefined,
        );
    },
    onServerRequest(r: MuseServerRequest): Promise<Record<string, unknown>> {
      if (ready) return request(r);
      return new Promise((resolve, reject) => {
        const rejectRequest = (cause: unknown) => {
          bufferedRequests.delete(rejectRequest);
          reject(cause);
        };
        bufferedRequests.add(rejectRequest);
        enqueue(async () => {
          try {
            const result = await request(r);
            bufferedRequests.delete(rejectRequest);
            resolve(result);
          } catch (cause) {
            rejectRequest(cause);
          }
        }, rejectRequest);
      });
    },
    async activate(recoveryEvents: ReadonlyArray<ProviderRuntimeEvent> = []) {
      if (failed) throw failed;
      for (const event of recoveryEvents) {
        if (event.type === "turn.completed" && event.turnId)
          recoveredTurns.set(event.turnId, { event, published: false });
      }
      // Keep queueing during replay to retain relative ordering with newly arriving callbacks.
      while (queue.length) await queue.shift()!.run();
      const state = input.getState();
      if (state && !state.closed && !failed)
        for (const turnId of recoveredTurns.keys()) publishRecovered(turnId, state);
      ready = true;
      if (failed) throw failed;
    },
    fail(cause: unknown) {
      failed = cause;
      for (const pending of queue.splice(0)) pending.reject(cause);
      for (const rejectRequest of bufferedRequests) rejectRequest(cause);
    },
  };
}
