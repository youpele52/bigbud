import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ClientRelayStdioSocket } from "./clientRelay.stdio.ts";

/** Exit/waitpid confirmation owns cleanup; inherited stderr must never hold 'close' forever. */
export function ownClientRelaySshChild(child: ChildProcessWithoutNullStreams, signal: AbortSignal) {
  const stream = new ClientRelayStdioSocket(child.stdout, child.stdin);
  let reaped = false,
    bytes = 0,
    force: NodeJS.Timeout | undefined;
  let confirmExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    confirmExit = resolve;
  });
  const confirm = () => {
    if (reaped) return;
    reaped = true;
    if (force) clearTimeout(force);
    // An exited SSH process can leave this pipe open in a ProxyCommand descendant.
    child.stderr.destroy();
    // stdout can still contain the final HTTP response after waitpid. Let it drain;
    // explicit owner disposal already destroys the stream before awaiting this exit.
    confirmExit();
  };
  const abort = () => stream.destroy();
  signal.addEventListener("abort", abort, { once: true });
  // Keep pre-observer startup errors handled; consumers still receive the same error event.
  stream.on("error", () => {});
  stream.once("close", () => {
    signal.removeEventListener("abort", abort);
    if (child.exitCode !== null || child.signalCode !== null) {
      confirm();
      return;
    }
    if (!reaped) {
      child.kill("SIGTERM");
      if (!reaped) {
        force = setTimeout(() => {
          if (!reaped) child.kill("SIGKILL");
        }, 1000);
        force.unref();
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) stream.destroy(new Error("SSH relay diagnostics exceeded limit."));
  });
  child.once("error", () => {
    stream.destroy(new Error("SSH backend relay could not start."));
    if (child.pid === undefined) confirm(); // Failed spawn has no child to reap.
  });
  child.once("exit", (code, exitSignal) => {
    if (code !== null || exitSignal !== null) confirm();
    else stream.destroy();
  });
  if (child.exitCode !== null || child.signalCode !== null) confirm();
  if (signal.aborted) stream.destroy();
  return {
    stream,
    exited,
    async waitForExit(timeoutMs: number) {
      if (reaped) return;
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error("SSH relay cleanup could not confirm owned child exit.")),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    },
  };
}
