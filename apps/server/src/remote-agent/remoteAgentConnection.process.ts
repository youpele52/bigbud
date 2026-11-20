import type { ChildProcessWithoutNullStreams } from "node:child_process";
/** Only the original spawn handle may establish exit. Never inspect/adopt another PID. */
export function trackRemoteAgentProcess(child: ChildProcessWithoutNullStreams) {
  let confirmed = false,
    resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const confirm = () => {
    confirmed = true;
    resolveExit();
  };
  child.once("exit", (code, signal) => {
    if (code !== null || signal !== null) confirm();
  });
  child.once("error", () => {
    if (child.pid === undefined) confirm();
  });
  if (child.exitCode !== null || child.signalCode !== null) confirm();
  return {
    async confirmClose(timeoutMs: number) {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
        throw new Error("Invalid original proxy cleanup deadline.");
      let force: ReturnType<typeof setTimeout> | undefined,
        deadline: ReturnType<typeof setTimeout> | undefined,
        killFailure: unknown;
      try {
        if (!confirmed) {
          force = setTimeout(
            () => {
              if (!confirmed) {
                try {
                  if (!child.kill("SIGKILL"))
                    killFailure = new Error("Original proxy signal was not delivered.");
                } catch (cause) {
                  killFailure = cause;
                }
              }
            },
            Math.min(1000, timeoutMs / 2),
          );
          force.unref();
          await Promise.race([
            exited,
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(
                () =>
                  reject(
                    new Error("Remote proxy cleanup could not confirm original child exit.", {
                      cause: killFailure,
                    }),
                  ),
                timeoutMs,
              );
            }),
          ]);
        }
        // This is cleanup after connection close, so no final protocol bytes are discarded while active.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      } finally {
        if (force) clearTimeout(force);
        if (deadline) clearTimeout(deadline);
      }
    },
  };
}
export async function closeAndConfirmRemoteAgentProcess(
  close: () => void,
  owned: ReturnType<typeof trackRemoteAgentProcess>,
  timeoutMs: number,
) {
  let closeFailure: unknown;
  try {
    close();
  } catch (cause) {
    closeFailure = cause;
  }
  await owned.confirmClose(timeoutMs);
  if (closeFailure !== undefined) throw closeFailure;
}
/** Preserve legacy graceful-close behavior; callers needing confirmed reap use closeConfirmed. */
export async function finishRemoteAgentGracefulClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  close: () => void,
) {
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stdin.end();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!settled) close();
}
