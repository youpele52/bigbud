import type { RemoteAgentFrame } from "./remoteAgentProtocol";

export interface FrameWaiter {
  readonly resolve: (frame: RemoteAgentFrame) => void;
  readonly reject: (error: Error) => void;
  readonly matches?: (frame: RemoteAgentFrame) => boolean;
}

/** Cancellation retires local observation only; it never implies remote settlement. */
export function requestRemoteFrame(
  waiters: FrameWaiter[],
  send: () => Promise<void>,
  matches: NonNullable<FrameWaiter["matches"]>,
  signal?: AbortSignal,
): Promise<RemoteAgentFrame> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
    };
    const waiter: FrameWaiter = {
      matches,
      resolve: (frame) => {
        cleanup();
        resolve(frame);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    };
    const abort = () => waiter.reject(new Error("Remote request observation cancelled."));
    if (signal?.aborted) {
      abort();
      return;
    }
    waiters.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    void send().catch((error: unknown) =>
      waiter.reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}
