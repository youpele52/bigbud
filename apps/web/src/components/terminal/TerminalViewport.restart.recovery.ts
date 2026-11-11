import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type { createTerminalViewportDelivery } from "./TerminalViewport.delivery";
import { recordTerminalProfileSnapshot } from "./TerminalViewport.profile";
import {
  withTerminalLifecycleDeadline,
  withTerminalViewDeadline,
} from "./terminalLifecycle.operations";

type Delivery = ReturnType<typeof createTerminalViewportDelivery>;

/** Keep the old lane live while registration waits; check intent before replacing it. */
export async function prepareTerminalRestartDelivery<T>(
  subscribe: () => Promise<void>,
  replaceDelivery: () => T,
  isCurrent: () => boolean,
): Promise<T | undefined> {
  await subscribe();
  return isCurrent() ? replaceDelivery() : undefined;
}

export function isTerminalRestartNotStarted(error: unknown, previous: TerminalSessionSnapshot) {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as {
    _tag?: unknown;
    reason?: unknown;
    threadId?: unknown;
    terminalId?: unknown;
  };
  return (
    failure._tag === "TerminalExecutionTargetError" &&
    failure.reason === "restartNotStarted" &&
    failure.threadId === previous.threadId &&
    failure.terminalId === previous.terminalId
  );
}

/** Read-only attachment: never recover a refused/cancelled replacement by opening a process. */
export async function restoreTerminalRestartDelivery(
  input: {
    api: NativeApi;
    disposed: () => boolean;
    isCurrent: (delivery: Delivery) => boolean;
    onSnapshot: (snapshot: TerminalSessionSnapshot) => void;
  },
  previous: TerminalSessionSnapshot,
  delivery: Delivery | undefined,
) {
  const snapshot = await withTerminalLifecycleDeadline(
    input.api.terminal.snapshot!({ threadId: previous.threadId, terminalId: previous.terminalId }),
  );
  if (
    snapshot.threadId !== previous.threadId ||
    snapshot.terminalId !== previous.terminalId ||
    !snapshot.runtimeGeneration ||
    !recordTerminalProfileSnapshot(snapshot)
  )
    throw new Error("Terminal status could not be verified. Refresh the connection and retry.");
  if (!input.disposed() && delivery && input.isCurrent(delivery)) {
    input.onSnapshot(snapshot);
    if (snapshot.status === "running" && snapshot.pid !== null)
      await withTerminalViewDeadline(delivery.intake.hydrate(snapshot));
    else
      delivery.intake.pause(
        new Error("Terminal is not running. Review its output before retrying."),
      );
  }
  return snapshot;
}
