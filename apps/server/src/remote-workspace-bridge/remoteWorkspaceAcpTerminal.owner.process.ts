import { finished } from "node:stream/promises";

import type { AcpTerminalExit, AcpTerminalProcess } from "./remoteWorkspaceAcpTerminal.ts";
import type { AcpOwnerCommandLease } from "./remoteWorkspaceAcpTerminal.owner.ts";

export function makeOwnedAcpTerminalProcess(
  lease: AcpOwnerCommandLease,
  signal: AbortSignal,
): AcpTerminalProcess {
  const { output } = lease;
  const exits = new Set<(event: AcpTerminalExit) => void>();
  const errors = new Set<(error: Error) => void>();
  let outcome: AcpTerminalExit | undefined;
  let failure: Error | undefined;
  let reaped = false;
  let cancellation: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  const reportFailure = (cause: unknown) => {
    if (failure || outcome) return;
    failure = cause instanceof Error ? cause : new Error(String(cause));
    for (const listener of errors) listener(failure);
  };
  const cancel = () => {
    cancellation ??= Promise.resolve().then(() => {
      if (!reaped) return lease.cancel();
    });
    return cancellation;
  };
  const reap = lease.exit.then((exit) => {
    reaped = true;
    return exit;
  });
  output.pause();
  output.setEncoding("utf8");
  const settled = Promise.all([reap, finished(output, { cleanup: true, writable: false })]).then(
    ([exit]) => {
      if (failure) return;
      outcome =
        exit.kind === "exited"
          ? { exitCode: exit.code, signal: null }
          : { exitCode: null, signal: exit.signal };
      for (const listener of exits) listener(outcome);
    },
    (cause) => {
      output.destroy();
      void cancel().catch(() => {});
      throw cause;
    },
  );
  // A provider can subscribe after a fast owner failure or exit. Keep the result for late readers.
  void settled.catch(reportFailure);

  const close = (terminate = true): Promise<void> => {
    output.resume();
    if (!terminate) return Promise.resolve();
    return (closing ??= Promise.all([cancel(), settled]).then(() => {}));
  };
  const abort = () => {
    void close(true).catch(reportFailure);
  };
  signal.addEventListener("abort", abort, { once: true });
  const detachAbort = () => signal.removeEventListener("abort", abort);
  void settled.then(detachAbort, detachAbort);

  return {
    kill: () => {
      // ACP kill is termination; do not let callers choose remote signals or another lease.
      abort();
    },
    onData: (callback) => {
      output.on("data", callback);
      output.resume();
      return () => output.off("data", callback);
    },
    onExit: (callback) => {
      if (outcome) callback(outcome);
      else if (!failure) exits.add(callback);
      return () => exits.delete(callback);
    },
    onError: (callback) => {
      if (failure) callback(failure);
      else if (!outcome) errors.add(callback);
      return () => errors.delete(callback);
    },
    close,
  };
}
