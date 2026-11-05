import type { PtyProcess } from "../Services/PTY";
import type { TerminalSessionState } from "./Manager.types";

/** Native reads are held by either consumer; shutdown always wins so exit can drain. */
export function reconcileTerminalOutputPressure(
  session: TerminalSessionState,
  process: PtyProcess | null = session.process,
): void {
  if (!process?.pause || !process.resume) return;
  if (!session.stopPending && (session.recoveryOutputHeld || session.hasDeliveryOutputHold?.()))
    process.pause();
  else process.resume();
}
