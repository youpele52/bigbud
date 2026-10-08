import { Effect } from "effect";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { observeV2Admission } from "./Runtime.admission.ts";
import {
  correlatedProjection,
  readV2Messages,
  projectionEvents,
  runtimeEventBase,
} from "./Runtime.projection.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";
import { v2Request } from "./Client.ts";
import { flushV2FinalEvents, queueV2FinalEvents } from "./Runtime.finalization.ts";
import { v2RuntimeStatus } from "./Runtime.status.ts";
import { isV2AssistantSettled } from "./Projection.ts";

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
  let phase = "admission";
  try {
    let row = session.row;
    if (!row || row.state === "reserved") return;
    if (row.state === "dispatch-intent") {
      if (!(await observeV2Admission(session, row))) {
        await v2RuntimeStatus(
          runtime,
          session,
          "error",
          "Admission remains unconfirmed; no automatic resend or replacement. Check existing execution before retrying.",
        );
        return;
      }
      row = await Effect.runPromise(
        runtime.options.journal.transition(row, "accepted", new Date().toISOString()),
      );
      if (session.stopped) return;
      session.row = row;
    }
    phase = "message projection";
    const messages = await readV2Messages(session);
    if (session.stopped) return;
    const projection = correlatedProjection(session, messages);
    if (!projection) {
      await v2RuntimeStatus(
        runtime,
        session,
        "error",
        "Native output correlation remains unconfirmed; no automatic resend.",
      );
      return;
    }
    if (row.state === "terminal" && row.terminalOutcome && projection.idle) {
      const observed =
        projection.idle.outcome === "succeeded"
          ? "completed"
          : projection.idle.outcome === "failed"
            ? "failed"
            : "interrupted";
      if (row.terminalOutcome !== observed)
        throw new Error("V2 durable/native terminal outcome conflict.");
    }
    for (const message of projection.assistants) session.messages.set(message.id, message);
    phase = "output repair";
    for (const event of projectionEvents(session, projection.assistants))
      await runtime.emit(session, event);
    phase = "interaction projection";
    const interactions = await pendingV2Interactions(session);
    if (session.stopped) return;
    for (const event of interactions) await runtime.emit(session, event);
    const pending = interactions.some(
      (event) => event.type === "request.opened" || event.type === "user-input.requested",
    );
    const retry = projection.assistants.at(-1)?.retry;
    if (row.state !== "terminal")
      await v2RuntimeStatus(
        runtime,
        session,
        pending || retry ? "waiting" : "running",
        retry
          ? `Native retry ${retry.attempt} scheduled; existing execution is still owned. No new admission or application resend.`
          : projection.assistants.length === 0
            ? "Native admission accepted; waiting for output. No automatic resend."
            : undefined,
      );
    let terminalOutcome = projection.idle?.outcome;
    const last = projection.assistants.at(-1);
    // Pinned native permission rejection persists an explicitly completed aborted step,
    // but no idle marker. Do not leave its accepted admission permanently running.
    if (
      !terminalOutcome &&
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
      if (row.state === "terminal" && row.terminalOutcome !== outcome)
        throw new Error("V2 durable/native terminal outcome conflict.");
      if (row.state !== "terminal")
        session.row = await Effect.runPromise(
          runtime.options.journal.transition(
            row,
            "terminal",
            new Date().toISOString(),
            text,
            outcome,
          ),
        );
      phase = "terminal delivery";
      if (session.stopped) return;
      await runtime.emit(session, {
        ...runtimeEventBase(session, `terminal:${row.turnId}`),
        type: "turn.completed",
        payload: {
          state: outcome,
          ...(outcome === "failed" ? { errorMessage: "OpenCode v2 native execution failed." } : {}),
          totalCostUsd: projection.assistants.reduce(
            (sum, message) => sum + (message.cost ?? 0),
            0,
          ),
        },
      });
      await v2RuntimeStatus(runtime, session, "ready");
      session.terminalDelivered = true;
      session.session = {
        ...session.session,
        status: "ready",
        activeTurnId: undefined,
        lastError: undefined,
      };
    }
    if (!session.lease.hub.reconciled(session.native.id, generation))
      runtime.scheduleRepair(session);
    session.lease.hub.start();
  } catch {
    await v2RuntimeStatus(
      runtime,
      session,
      "error",
      `V2 ${phase} state remains unconfirmed; no automatic resend or replacement. Stop the session to cancel pending work; retry only after existing execution is confirmed.`,
    );
  }
}
