import type {
  OrchestrationBaselineAckInput,
  OrchestrationBaselineAckResult,
} from "@bigbud/contracts/orchestration/orchestration.delivery.ts";

import type { DesktopSupervisorDeliverySession } from "./desktopSupervisorDelivery.session.ts";
import { inspectCompleteReplay } from "./desktopSupervisorDelivery.session.replay.ts";
import { DesktopSupervisorProtocolError } from "./desktopSupervisorProtocol.ts";

export async function acknowledgeProjectionBaseline(
  session: DesktopSupervisorDeliverySession,
  input: OrchestrationBaselineAckInput,
): Promise<OrchestrationBaselineAckResult> {
  const rejected = () => ({
    accepted: false,
    fenced: true,
    acknowledgedSequence: session.acknowledgedSequence,
  });
  if (
    session.closed ||
    input.consumerId !== session.consumerId ||
    input.consumerGeneration !== session.generation ||
    input.serverEpoch !== session.coordinator.serverEpoch ||
    !session.coordinator.isAuthoritative(session) ||
    session.ackGate
  ) {
    return rejected();
  }
  if (session.lastBaseline?.recoveryId === input.recoveryId) {
    return session.lastBaseline.sequence === input.appliedProjectionSequence
      ? { accepted: true, fenced: false, acknowledgedSequence: session.lastBaseline.sequence }
      : rejected();
  }
  const gate = session.baselineGate;
  if (
    !gate ||
    gate.recoveryId !== input.recoveryId ||
    input.appliedProjectionSequence <= session.acknowledgedSequence
  ) {
    return rejected();
  }
  try {
    const inspection = await inspectCompleteReplay({
      acknowledgedSequence: input.appliedProjectionSequence,
      readReplay: session.readReplay,
    });
    if (
      session.closed ||
      session.baselineGate !== gate ||
      !session.coordinator.isAuthoritative(session)
    ) {
      return rejected();
    }
    if (
      inspection.recoveryReason ||
      input.appliedProjectionSequence > inspection.replay.latestSequence
    ) {
      return { accepted: false, fenced: false, acknowledgedSequence: session.acknowledgedSequence };
    }
    const sequence =
      session.route === "supervisor"
        ? await session.coordinator.installSupervisorBaseline(session, input)
        : input.appliedProjectionSequence;
    if (
      session.closed ||
      session.baselineGate !== gate ||
      !session.coordinator.isAuthoritative(session)
    ) {
      return rejected();
    }
    if (sequence !== input.appliedProjectionSequence) {
      throw new Error("desktop supervisor installed an unexpected projection baseline");
    }
    session.acknowledgedSequence = sequence;
    session.deliverySequence = sequence;
    for (const pendingSequence of session.pending.keys()) {
      if (pendingSequence <= sequence) session.pending.delete(pendingSequence);
    }
    session.shadow.observeBaseline(sequence);
    session.lastBaseline = { recoveryId: input.recoveryId, sequence };
    session.baselineGate = null;
    gate.resolve();
    return { accepted: true, fenced: false, acknowledgedSequence: sequence };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (error instanceof DesktopSupervisorProtocolError && error.code === "timeout") {
      throw error;
    }
    session.baselineGate = null;
    gate.reject(error);
    throw error;
  }
}
