import type { NativeApi, ThreadId } from "@bigbud/contracts";
import { forgetTerminalLaunch, readTerminalLaunch } from "../../lib/terminalLaunchBinding";
import {
  beginTerminalLifecycle,
  finishTerminalLifecycle,
  readTerminalLifecycle,
  updateTerminalLifecycle,
} from "../../stores/terminal/terminalLifecycle.store";
import { recoverStaleTerminalLifecycle } from "./terminalLifecycle.recovery";

/** A deadline means uncertainty, not cancellation or permission to spawn a replacement. */
export async function withTerminalLifecycleDeadline<A>(
  operation: Promise<A>,
  timeoutMessage = "Terminal operation is still unconfirmed. Check the connection, then retry; no additional shell was requested.",
): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** View recovery failure says nothing about the already-confirmed shell lifecycle. */
export function withTerminalViewDeadline<A>(presentation: Promise<A>): Promise<A> {
  return withTerminalLifecycleDeadline(
    presentation,
    "Terminal view recovery timed out. The server outcome is confirmed; reload the view to reconnect without restarting the shell.",
  );
}

export async function closeTerminalConfirmed(input: {
  api: NativeApi;
  threadId: ThreadId;
  terminalId: string;
  onPending?: () => void;
  onConfirmed: () => void;
}) {
  const { api, threadId, terminalId } = input;
  const operation = beginTerminalLifecycle(threadId, terminalId, "close");
  if (!operation) return;
  input.onPending?.();
  try {
    if (typeof api.terminal.close !== "function")
      throw new Error(
        "This server does not support confirmed terminal close. Reconnect to an updated server and retry.",
      );
    await withTerminalLifecycleDeadline(
      (async () => {
        if (!operation.expectedGeneration) {
          const generation =
            readTerminalLaunch(threadId, terminalId)?.runtimeGeneration ??
            (await api.terminal.snapshot?.({ threadId, terminalId }).catch(() => undefined))
              ?.runtimeGeneration;
          if (generation)
            updateTerminalLifecycle(threadId, terminalId, operation, {
              expectedGeneration: generation,
            });
        }
        await api.terminal.close!({
          threadId,
          terminalId,
          deleteHistory: true,
          ...(operation.expectedGeneration
            ? { expectedGeneration: operation.expectedGeneration }
            : { onlyIfNotRunning: true }),
        }).then(() => {
          if (readTerminalLifecycle(threadId, terminalId)?.id !== operation.id) return;
          input.onConfirmed();
          forgetTerminalLaunch(threadId, terminalId);
          finishTerminalLifecycle(threadId, terminalId, operation);
        });
      })(),
    );
  } catch (cause) {
    let failure = cause;
    try {
      if (
        await recoverStaleTerminalLifecycle({
          error: cause,
          threadId,
          terminalId,
          operation,
          refresh: () =>
            withTerminalLifecycleDeadline(api.terminal.snapshot!({ threadId, terminalId })),
        })
      )
        return;
    } catch (refreshError) {
      failure = refreshError;
    }
    updateTerminalLifecycle(threadId, terminalId, operation, {
      phase: "error",
      canDismiss:
        typeof failure === "object" &&
        failure !== null &&
        "reason" in failure &&
        failure.reason === "directShellUnconfirmed" &&
        "threadId" in failure &&
        failure.threadId === threadId &&
        "terminalId" in failure &&
        failure.terminalId === terminalId,
      error:
        failure instanceof Error
          ? failure.message
          : "Terminal close failed. Retry to confirm shutdown.",
    });
  }
}
