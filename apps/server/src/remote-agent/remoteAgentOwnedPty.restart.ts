const RESTART_TIMEOUT_MS = 10_000;

/** A close acknowledgement is not exit, and exit is not durable owner release. */
export function makeRemotePtyRestartBarrier(close: () => Promise<void>) {
  let resolveExit!: () => void;
  let rejectExit!: (error: unknown) => void;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  // Natural exits can settle before anyone requests restart.
  void exited.catch(() => undefined);
  let termination: Promise<void> | undefined;
  return {
    recordExit(definitive: boolean, persisted: Promise<unknown>) {
      void persisted.then(() => {
        if (definitive) resolveExit();
        else
          rejectExit(new Error("Remote terminal exit is uncertain; no replacement was started."));
      }, rejectExit);
    },
    async prepareRestart(): Promise<void> {
      // Repeated user retries after a timeout share the outstanding termination,
      // rather than accumulating close requests and unresolved exit waiters.
      if (!termination) {
        const current = close().then(() => exited);
        termination = current;
        void current.catch(() => {
          if (termination === current) termination = undefined;
        });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          termination,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Remote terminal termination or durable owner release timed out; no replacement was started.",
                  ),
                ),
              RESTART_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
