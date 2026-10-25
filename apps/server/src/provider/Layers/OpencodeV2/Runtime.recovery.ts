import { Effect } from "effect";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { observeV2Admission } from "./Runtime.admission.ts";
import {
  correlatedProjection,
  readV2Messages,
  projectionEvents,
  runtimeEventBase,
  v2ProjectionConflict,
} from "./Runtime.projection.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";
import { v2Request } from "./Client.ts";
import { flushV2FinalEvents, queueV2FinalEvents } from "./Runtime.finalization.ts";
import { v2RuntimeStatus } from "./Runtime.status.ts";
import { isV2AssistantSettled } from "./Projection.ts";
import { v2NativeFailureMessage } from "./Runtime.failure.ts";
import { observeV2Subagents } from "./Runtime.subagents.ts";
import { observeV2OwnedFamily } from "./Runtime.family.observe.ts";
import { readV2FamilyProjectionInputs } from "./Runtime.family.projection.ts";
import { recoverV2FamilyStop } from "./Runtime.family.stop.ts";
import { verifyV2BackgroundProjection, V2BackgroundContractError } from "./Runtime.background.ts";
import { retainV2FamilyOnProcessLoss } from "./Runtime.family.loss.ts";
import { isV2CancelledReservation } from "./Admission.cancelled.ts";

/** Invalidate pending interaction and output ownership immediately on owned process exit. */
export async function v2RuntimeProcessLost(runtime: OpencodeV2Runtime, session: V2RuntimeSession) {
  session.lossPending = true;
  session.stopped = true;
  session.coding?.revoke();
  await session.coding?.cancelActive();
  session.unregister();
  if (session.lease.process.hasExited?.() !== true) {
    session.executionBlocked =
      "V2 transport unavailable; native execution/cleanup remains unconfirmed. No replacement or resend.";
    session.session = { ...session.session, status: "error", lastError: session.executionBlocked };
    return;
  }
  if (await retainV2FamilyOnProcessLoss(runtime, session)) return;
  session.unsubscribeDeath();
  session.session = {
    ...session.session,
    status: "error",
    activeTurnId: undefined,
    lastError:
      session.row?.state === "dispatch-intent"
        ? "Owned V2 process exited; admission remains unconfirmed. No automatic resend or recovery."
        : "Owned V2 process exited; execution interrupted and pending interactions invalidated.",
  };
  const row = session.row;
  if (row?.state === "accepted") {
    session.row = await Effect.runPromise(
      runtime.options.journal.transition(
        row,
        "terminal",
        new Date().toISOString(),
        undefined,
        "interrupted",
      ),
    );
  }
  if (session.row?.state === "terminal" && session.row.terminalOutcome === "interrupted") {
    queueV2FinalEvents(session, [
      {
        ...runtimeEventBase(session, `lost:${session.row.turnId}`),
        type: "turn.aborted",
        payload: { reason: "Owned OpenCode v2 process exited; execution interrupted." },
      },
    ]);
  }
  queueV2FinalEvents(session, [
    {
      ...runtimeEventBase(session, `exited:${session.lease.generation}`),
      type: "session.exited",
      payload: { reason: session.session.lastError, recoverable: false },
    },
  ]);
  await session.resources?.cleanup();
  session.lossPending = false;
  await flushV2FinalEvents(session, (owner, event) => runtime.emit(owner, event));
}

/** Repair output before the durable terminal claim; unknown state never dispatches. */
export async function reconcileV2Runtime(runtime: OpencodeV2Runtime, session: V2RuntimeSession) {
  if (session.stopped) {
    if (session.lossPending) await v2RuntimeProcessLost(runtime, session);
    if (await runtime.teardown.repair(session)) return;
    await flushV2FinalEvents(session, (owner, event) => runtime.emit(owner, event));
    return;
  }
  if (session.stopped || !session.lease.process.isRunning()) return;
  const generation = session.lease.hub.generation(session.native.id);
  const dirtyGeneration = session.dirtyGeneration;
  const epoch = session.epoch;
  const arrivalFence = session.lease.hub.captureArrivalFence(session.native.id);
  let background = false;
  const validate = () => {
    session.consentPermit?.assertCurrent();
    if (background) arrivalFence?.();
    if (
      session.stopped ||
      runtime.sessions.get(session.threadId) !== session ||
      epoch !== session.epoch ||
      session.dirtyGeneration !== dirtyGeneration ||
      session.lease.hub.generation(session.native.id) !== generation ||
      !session.lease.process.isRunning()
    )
      throw new Error("V2 late recovery snapshot owner/generation rejected.");
  };
  let phase = "admission";
  try {
    await recoverV2FamilyStop(session);
    await observeV2OwnedFamily(runtime, session, validate);
    let row = session.row;
    if (!row || row.state === "reserved") return;
    if (isV2CancelledReservation(row)) {
      session.terminalDelivered = true;
      await v2RuntimeStatus(runtime, session, "ready", undefined, validate);
      return;
    }
    phase = "canonical publication";
    if (session.publicationUnconfirmed) throw new Error("V2 canonical publication unconfirmed.");
    phase = "admission";
    if (row.state === "dispatch-intent") {
      const observed = await observeV2Admission(session, row);
      validate();
      if (!observed) {
        await v2RuntimeStatus(
          runtime,
          session,
          "error",
          "Admission remains unconfirmed; no automatic resend or replacement. Check existing execution before retrying.",
          validate,
        );
        return;
      }
      row = await Effect.runPromise(
        runtime.options.journal.transition(row, "accepted", new Date().toISOString()),
      );
      validate();
      if (session.stopped) return;
      session.row = row;
    }
    phase = "message projection";
    const messages = await readV2Messages(session);
    validate();
    if (session.stopped) return;
    const nativeInputs = await readV2FamilyProjectionInputs(session, messages, validate);
    const projection = correlatedProjection(session, messages, nativeInputs);
    if (!projection) {
      await v2RuntimeStatus(
        runtime,
        session,
        "error",
        v2ProjectionConflict(session, messages) ??
          "Native output correlation remains unconfirmed; no automatic resend.",
        validate,
      );
      return;
    }
    background = Boolean(projection.background);
    validate();
    phase = "background continuation closure";
    const snapshotClosed = await verifyV2BackgroundProjection(
      session,
      projection,
      messages,
      validate,
    );
    validate();
    // bigbud is the sole input writer of this exact app-owned native conversation. CLI
    // conversations may run on the same service; observed same-session arrivals still fence us.
    // This does not claim atomic exclusion of arbitrary external writes into this conversation.
    const backgroundClosed = snapshotClosed && (!background || Boolean(arrivalFence));
    if (background && backgroundClosed && arrivalFence)
      session.backgroundClosure = { turnId: row.turnId, assertCurrent: arrivalFence };
    const projectedOutcome = projection.terminalOutcome ?? projection.idle?.outcome;
    if (row.state === "terminal" && row.terminalOutcome && projectedOutcome && backgroundClosed) {
      const observed =
        projectedOutcome === "succeeded"
          ? "completed"
          : projectedOutcome === "failed"
            ? "failed"
            : "interrupted";
      if (row.terminalOutcome !== observed)
        throw new Error("V2 durable/native terminal outcome conflict.");
    }
    for (const message of projection.assistants) session.messages.set(message.id, message);
    phase = "output repair";
    for (const event of projectionEvents(session, projection.assistants))
      await runtime.emit(session, event, validate);
    phase = "interaction projection";
    const interactions = await pendingV2Interactions(session);
    validate();
    if (session.stopped) return;
    for (const event of interactions) await runtime.emit(session, event, validate);
    const pending = interactions.some(
      (event) => event.type === "request.opened" || event.type === "user-input.requested",
    );
    const retry = projection.assistants.at(-1)?.retry;
    if (row.state !== "terminal")
      await v2RuntimeStatus(
        runtime,
        session,
        pending || retry || (background && !backgroundClosed) ? "waiting" : "running",
        background && !backgroundClosed
          ? "Native background continuation closure remains unconfirmed for this conversation; new messages remain blocked. No automatic resend."
          : retry
            ? `Native retry ${retry.attempt} scheduled; existing execution is still owned. No new admission or application resend.`
            : projection.assistants.length === 0
              ? "Native admission accepted; waiting for output. No automatic resend."
              : undefined,
        validate,
      );
    let terminalOutcome = backgroundClosed && projection.idle ? projectedOutcome : undefined;
    const last = projection.assistants.at(-1);
    // Pinned native permission rejection persists an explicitly completed aborted step,
    // but no idle marker. Do not leave its accepted admission permanently running.
    if (
      !terminalOutcome &&
      !projection.background &&
      !pending &&
      last?.error?.type === "aborted" &&
      projection.assistants.every(isV2AssistantSettled)
    ) {
      const active = await v2Request("session.active", (signal) =>
        session.lease.process.client.session.active({ signal }),
      );
      const inbox = await v2Request("session.inbox.list", (signal) =>
        session.lease.process.client.session.inbox.list(
          { sessionID: session.native.id },
          { signal },
        ),
      );
      if (inbox.length > 1000) throw new Error("V2 aborted-step inbox bound exceeded.");
      validate();
      if (!active[session.native.id] && !inbox.some((item) => item.id === row.nativeAdmissionId))
        terminalOutcome = "interrupted";
    }
    if (terminalOutcome) {
      if (
        pending ||
        projection.assistants.some((message) => !isV2AssistantSettled(message)) ||
        projection.assistants.at(-1)?.retry
      )
        return;
      const text = projection.assistants
        .filter(
          (message) =>
            !message.error &&
            !message.retry &&
            message.finish !== "error" &&
            message.finish !== "unknown",
        )
        .flatMap((message) =>
          message.content.filter((part) => part.type === "text").map((part) => part.text),
        )
        .join("");
      const outcome =
        terminalOutcome === "succeeded"
          ? "completed"
          : terminalOutcome === "failed"
            ? "failed"
            : "interrupted";
      phase = "terminal journal";
      validate();
      if (row.state === "terminal" && row.terminalOutcome !== outcome)
        throw new Error("V2 durable/native terminal outcome conflict.");
      if (row.state !== "terminal") {
        const terminal = await Effect.runPromise(
          runtime.options.journal.transition(
            row,
            "terminal",
            new Date().toISOString(),
            text,
            outcome,
          ),
        );
        validate();
        session.row = terminal;
      }
      phase = "terminal delivery";
      validate();
      if (session.publicationUnconfirmed) {
        phase = "canonical publication";
        throw new Error("V2 canonical publication unconfirmed.");
      }
      if (session.stopped) return;
      await runtime.emit(
        session,
        {
          ...runtimeEventBase(session, `terminal:${row.turnId}`),
          type: "turn.completed",
          payload: {
            state: outcome,
            ...(last?.model
              ? {
                  actualModelSelection: {
                    provider: "opencodeV2" as const,
                    model: last.model.id,
                    subProviderID: last.model.providerID,
                  },
                }
              : {}),
            ...(outcome === "failed" ? { errorMessage: v2NativeFailureMessage(last) } : {}),
            totalCostUsd: projection.assistants.reduce(
              (sum, message) => sum + (message.cost ?? 0),
              0,
            ),
          },
        },
        validate,
      );
      await v2RuntimeStatus(runtime, session, "ready", undefined, validate);
      if (session.publicationUnconfirmed) {
        phase = "canonical publication";
        throw new Error("V2 canonical publication unconfirmed.");
      }
      session.terminalDelivered = true;
      session.session = {
        ...session.session,
        status: "ready",
        activeTurnId: undefined,
        lastError: undefined,
      };
    }
    // A dirty owner still unwinding requests its next fresh read from onDrained.
    // Merely scheduling that retry must not invalidate the projection just queued.
    session.lease.hub.reconciled(session.native.id, generation);
    session.lease.hub.start();
    // Read-only and never throws; it is not liveness or ownership evidence.
    await observeV2Subagents(runtime, session, projection.assistants, validate);
  } catch (error) {
    try {
      validate();
    } catch {
      return;
    }
    await v2RuntimeStatus(
      runtime,
      session,
      "error",
      error instanceof V2BackgroundContractError
        ? error.message
        : `V2 ${phase} state remains unconfirmed; no automatic resend or replacement. Stop the session to cancel pending work; retry only after existing execution is confirmed.`,
    );
  }
}
