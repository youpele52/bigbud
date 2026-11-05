import type { PtyProcess } from "../Services/PTY";
import type { TerminalSessionState } from "./Manager.types";
import { createTerminalRecoveryModel } from "./TerminalRecoveryModel";
import { RECOVERY_PENDING_BYTES } from "./TerminalRecoveryModel.budget";
import { reconcileTerminalOutputPressure } from "./Manager.outputPressure";

/** A recovered remote process has no birth-to-cut baseline; never seed it with empty state. */
export function startRecoveryModel(
  session: TerminalSessionState,
  recovered: boolean,
  process?: PtyProcess,
): void {
  session.recoveryModel?.dispose("generation-replaced");
  session.recoveryOutputHeld = false;
  session.hasDeliveryOutputHold = undefined;
  const generation = session.runtimeGeneration;
  // Install before onData: adapters may emit synchronously during listener registration.
  session.reconcileOutputHold = () =>
    reconcileTerminalOutputPressure(session, process ?? session.process);
  session.recoveryModel = recovered
    ? undefined
    : createTerminalRecoveryModel(session.runtimeGeneration, session.cols, session.rows, (held) => {
        if (session.runtimeGeneration !== generation) return;
        session.recoveryOutputHeld = held;
        session.reconcileOutputHold?.();
      });
}

/** Hold synchronous native resize callbacks until we know whether the size was applied. */
export function feedRecoveryModel(session: TerminalSessionState, data: string): void {
  const held = session.recoveryResizeOutput;
  if (!held) {
    session.recoveryModel?.write(data);
    return;
  }
  if (held.bytes + data.length * 2 > RECOVERY_PENDING_BYTES || held.chunks.length >= 4096) {
    session.recoveryModel?.dispose("resize-output-budget");
    held.chunks = [];
    held.bytes = 0;
    return;
  }
  if (session.recoveryModel?.unavailableReason) return;
  held.chunks.push(data);
  held.bytes += data.length * 2;
}

/** Native success and model resize precede synchronous output; failed resize retains old geometry. */
export function resizeWithRecovery(
  session: TerminalSessionState,
  process: PtyProcess,
  cols: number,
  rows: number,
): void {
  if (!session.recoveryModel || session.recoveryModel.unavailableReason) {
    process.resize(cols, rows);
    return;
  }
  const held = { bytes: 0, chunks: [] as string[] };
  session.recoveryResizeOutput = held;
  try {
    process.resize(cols, rows);
    session.recoveryModel?.resize(cols, rows);
  } finally {
    session.recoveryResizeOutput = undefined;
    for (const data of held.chunks) session.recoveryModel?.write(data);
  }
}
