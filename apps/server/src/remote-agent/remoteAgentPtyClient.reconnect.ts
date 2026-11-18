import { RemoteAgentPtyError } from "./remoteAgentPtyClient.types";
import type { RemoteAgentConnection } from "./remoteAgentConnection";
import { runRemoteAgentReconnectEpisode } from "./remoteAgentReconnectPolicy";

/** Cancel this observer, never the shared connection acquisition. Late arrivals cannot attach. */
export async function observeRemotePtyConnection(
  acquisition: Promise<RemoteAgentConnection>,
  signal: AbortSignal,
): Promise<RemoteAgentConnection> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      acquisition,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export function reconnectRemotePty(input: {
  connect: () => Promise<RemoteAgentConnection>;
  attach: (connection: RemoteAgentConnection, signal: AbortSignal) => Promise<void>;
  cancelled: () => boolean;
  signal: AbortSignal;
  delay?: (ms: number) => Promise<void>;
}) {
  return runRemoteAgentReconnectEpisode({
    cancelled: input.cancelled,
    delay:
      input.delay ??
      ((ms) =>
        new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            input.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, ms);
          timer.unref?.();
          input.signal.addEventListener("abort", finish, { once: true });
          if (input.signal.aborted) finish();
        })),
    attempt: async () => {
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
      signal.throwIfAborted();
      const connection = await observeRemotePtyConnection(input.connect(), signal);
      signal.throwIfAborted();
      if (!input.cancelled()) await input.attach(connection, signal);
    },
  });
}

export function remotePtyReconnectFailure(result: {
  status: "stopped" | "exhausted";
  cause: unknown;
}): Error {
  return result.status === "stopped"
    ? new RemoteAgentPtyError(
        "PTY_RECONNECT_STOPPED",
        `Remote PTY reconnect stopped: ${result.cause instanceof Error ? result.cause.message : "authentication or host verification is required"}.`,
      )
    : new RemoteAgentPtyError(
        "PTY_RECONNECT_EXHAUSTED",
        "Remote PTY reconnect attempts exhausted; reopen the terminal to retry.",
      );
}

export function remotePtyInterruptedError(): Error {
  return new RemoteAgentPtyError(
    "REMOTE_SERVICE_RESTARTED",
    "Remote service restarted; terminal ownership was interrupted and was not replayed.",
  );
}
