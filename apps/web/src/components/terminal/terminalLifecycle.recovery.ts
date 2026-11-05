import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { recordTerminalLaunch } from "../../lib/terminalLaunchBinding";
import {
  finishTerminalLifecycle,
  readTerminalLifecycle,
  type TerminalLifecycleOperation,
} from "../../stores/terminal/terminalLifecycle.store";
import { toastManager } from "../ui/toast.manager";
import { withTerminalViewDeadline } from "./terminalLifecycle.operations";

type RefreshListener = (
  snapshot: TerminalSessionSnapshot,
) => boolean | void | Promise<boolean | void>;
const refreshListeners = new Set<RefreshListener>();

/** Existing views adopt the refreshed generation without issuing an open or a restart. */
export function subscribeTerminalLifecycleRefresh(
  threadId: string,
  terminalId: string,
  onSnapshot: RefreshListener,
  hydrate: RefreshListener,
) {
  const listener: RefreshListener = async (snapshot) => {
    if (snapshot.threadId !== threadId || snapshot.terminalId !== terminalId) return;
    if ((await onSnapshot(snapshot)) === false) return;
    await hydrate(snapshot);
  };
  refreshListeners.add(listener);
  return () => {
    refreshListeners.delete(listener);
  };
}

/** Completion belongs to the operation, not the viewport that initiated it. */
export async function refreshTerminalLifecycleViews(
  snapshot: TerminalSessionSnapshot,
): Promise<void> {
  await Promise.allSettled(
    [...refreshListeners].map((listener) =>
      withTerminalViewDeadline(Promise.resolve().then(() => listener(snapshot))),
    ),
  );
}

function isDefinitiveStaleGeneration(error: unknown, threadId: string, terminalId: string) {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as {
    _tag?: unknown;
    reason?: unknown;
    threadId?: unknown;
    terminalId?: unknown;
  };
  return (
    failure._tag === "TerminalExecutionTargetError" &&
    failure.reason === "staleGeneration" &&
    failure.threadId === threadId &&
    failure.terminalId === terminalId
  );
}

/** Only a structured, pre-mutation refusal permits abandoning the old operation identity. */
export async function recoverStaleTerminalLifecycle(input: {
  error: unknown;
  threadId: string;
  terminalId: string;
  operation: TerminalLifecycleOperation;
  refresh: () => Promise<TerminalSessionSnapshot>;
  onSnapshot?: RefreshListener;
}): Promise<boolean> {
  const { threadId, terminalId, operation } = input;
  if (!isDefinitiveStaleGeneration(input.error, threadId, terminalId)) return false;
  const snapshot = await input.refresh();
  if (
    snapshot.threadId !== threadId ||
    snapshot.terminalId !== terminalId ||
    !snapshot.runtimeGeneration
  )
    throw new Error("Terminal status could not be verified. Refresh the connection and retry.");
  if (readTerminalLifecycle(threadId, terminalId)?.id !== operation.id) return true;
  const accepted = recordTerminalLaunch(snapshot);
  finishTerminalLifecycle(threadId, terminalId, operation);
  if (accepted) {
    await Promise.allSettled([
      withTerminalViewDeadline(Promise.resolve().then(() => input.onSnapshot?.(snapshot))),
      refreshTerminalLifecycleViews(snapshot),
    ]);
  }
  toastManager.add({
    type: "warning",
    title: "Terminal session changed",
    description:
      "Its current session was refreshed. Review it, then choose Close or Restart again if needed.",
    timeout: 10_000,
    data: { threadId: ThreadId.makeUnsafe(snapshot.threadId) },
  });
  return true;
}
