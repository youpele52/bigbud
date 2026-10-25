import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { V2ThreadEnrollment } from "./Orchestration.enrollment.ts";
import type { V2ActiveExecutions } from "./Execution.owners.ts";
import type { V2ThreadReceipts } from "./Orchestration.receipts.ts";
import * as Effect from "effect/Effect";
import { V2ActivationBusy } from "./PluginSetup.activation.errors.ts";
import { v2Request } from "./Client.ts";
import { v2OrchestrationInvocationId } from "./Execution.orchestration.ts";
import { isThreadToolInvocationInFlight } from "../../../orchestration-tools/threadToolInvocationFlights.ts";
import { v2ReservedRetirementDrained } from "./Orchestration.bridge.reserved.ts";

/** H1 repair: a dispatched callback that failed is released only with exact native-drain proof plus
 * durable receipt evidence or a later interrupt acknowledgement. Unreadable evidence keeps it owned.
 * A "completed" receipt is terminal. "reserved" or "absent" is proof only while no canonical
 * handler or dispatch for the invocation is still in flight in this server process: the bigbud
 * route may outlive the caller's request timeout. */
export async function reconcileV2BridgeExecutions(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  active: V2ActiveExecutions,
  receipts: Pick<V2ThreadReceipts, "durableState">,
) {
  const uncertain = active.uncertainEntries();
  if (!uncertain.length) return 0;
  let native: Record<string, unknown>;
  try {
    native = await v2Request(
      "uncertain callback exact-session drain",
      (signal) => session.lease.process.client.session.active({ signal }),
      { timeoutMs: 5000 },
    );
  } catch {
    return 0; // No drain evidence: stay held; the caller's fences report authority loss.
  }
  if (runtime.sessions.get(session.threadId) !== session || session.stopped) return 0;
  const nativeDrained = !native[session.native.id];
  let released = 0;
  for (const entry of uncertain) {
    let receiptDurable = false;
    if (nativeDrained && entry.receiptKey)
      try {
        const state = await receipts.durableState(entry.receiptKey);
        receiptDurable =
          state === "completed" ||
          !isThreadToolInvocationInFlight(v2OrchestrationInvocationId(entry.receiptKey));
      } catch {
        receiptDurable = false; // Unreadable/invalid receipt evidence is never proof.
      }
    const interruptAcknowledged =
      (session.interruptAcknowledgedSequence ?? 0) > entry.failedSequence;
    if (
      active.reconcile(entry.controller, { nativeDrained, receiptDurable, interruptAcknowledged })
    )
      released++;
  }
  return released;
}

const admissionBusy = (session: V2RuntimeSession, reservedDrained = false) =>
  Boolean(
    (session.admissionInFlight &&
      !(
        session.activation?.token &&
        session.activation.gate.isUndispatched(session.activation.token)
      )) ||
    session.publicationUnconfirmed ||
    session.executionBlocked ||
    (session.row &&
      session.row.state !== "terminal" &&
      !(reservedDrained && session.row.state === "reserved")),
  );

/** No lease/timeout/registry observation substitutes for tracked physical and durable outcomes. */
export async function v2BridgeRetirementProof(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  active: V2ActiveExecutions,
  receipts: Pick<V2ThreadReceipts, "retirementEvidence">,
  controlsSettled: boolean,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const binding = runtime.options.sharedBindings
    ? await Effect.runPromise(runtime.options.sharedBindings.find(session.threadId))
    : undefined;
  signal?.throwIfAborted();
  const receiptEvidence = await receipts.retirementEvidence();
  signal?.throwIfAborted();
  const reservedDrained = await v2ReservedRetirementDrained(runtime, session, signal);
  return {
    physicalSettled: runtime.mutations.busyCount() === 0,
    controlsSettled,
    callbacksSettled: active.busyCount() === 0,
    creationSettled: runtime.options.config.sharedService
      ? binding?.state === "verified" &&
        binding.nativeSessionId === session.native.id &&
        binding.storageIdentity === session.storageIdentity
      : !runtime.hasPendingStart(session.threadId),
    admissionsSettled: !admissionBusy(session, reservedDrained),
    ...receiptEvidence,
  };
}

export function registerV2BridgeActivation(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  enrollment: V2ThreadEnrollment,
  active: V2ActiveExecutions,
  timer: ReturnType<typeof setInterval>,
  retired: () => void,
) {
  if (!session.activation || !runtime.options.activation) return undefined;
  const busyCount = () =>
    active.busyCount() +
    runtime.mutations.busyCount() +
    (admissionBusy(session) ? 1 : 0) +
    (session.family?.live ? 1 : 0) +
    (session.familyControl?.busyCount?.() ?? 0);
  return runtime.options.activation.coordinator.registerOwner(
    session.activation.gate,
    enrollment.digest,
    {
      diagnostics: () => {
        if (!session.threadToolsReady || session.stopped || session.executionBlocked)
          return undefined;
        try {
          enrollment.assertLive();
        } catch {
          return undefined;
        }
        return {
          threadId: session.threadId,
          directory: session.native.location.directory,
          implementationDigest: enrollment.options.owner.implementationDigest,
        };
      },
      busyCount,
      controlCount: () => enrollment.controlCount(),
      pauseRenewal: () => enrollment.pauseRenewal(),
      resumeRenewal: () => enrollment.resumeRenewal(),
      joinControl: (signal) => enrollment.joinControl(signal),
      retire: async (signal) => {
        signal.throwIfAborted();
        if (busyCount())
          throw new V2ActivationBusy("V2 canonical owner is busy; activation cannot cancel it.");
        clearInterval(timer);
        session.threadToolsReady = false;
        if (!(await enrollment.detach(signal)))
          throw new Error("V2 owner retirement remains physically unproved.");
        retired();
        signal.throwIfAborted();
      },
    },
  );
}
