import { withReadDeadline } from "../lib/readDeadline";
import { getWsConnectionStatus } from "../rpc/wsConnectionState";
import { useStore } from "../stores/main";

interface BootstrapRequest {
  start: () => void;
}

// One store per renderer: EventRouter and compact restoration share authority here,
// while separate windows have independent queues. API identity is not store identity.
const waiting: BootstrapRequest[] = [];
let active: BootstrapRequest | null = null;

function drain(): void {
  if (active !== null) return;
  const next = waiting.shift();
  if (!next) return;
  active = next;
  next.start();
}

function connectionEpoch(): string {
  const connection = getWsConnectionStatus();
  return JSON.stringify([
    useStore.getState().projectServerEpoch,
    connection.attemptCount,
    connection.phase,
    connection.connectedAt,
    connection.socketUrl,
  ]);
}

/** FIFO snapshot authority with a deadline that includes time waiting for the store. */
export function withBootstrapAuthority(
  operation: (signal: AbortSignal) => Promise<number>,
  timeoutMs: number,
): Promise<number> {
  const epoch = connectionEpoch();
  return withReadDeadline(
    (signal) =>
      new Promise<number>((resolve, reject) => {
        let finished = false;
        const finish = (result: { value: number } | { error: unknown }) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", cancel);
          const index = waiting.indexOf(request);
          if (index !== -1) waiting.splice(index, 1);
          if (active === request) active = null;
          if ("error" in result) reject(result.error);
          else resolve(result.value);
          // Settle the previous caller before granting the next snapshot writer authority.
          queueMicrotask(drain);
        };
        const cancel = () =>
          finish({ error: new Error("Project and thread loading timed out. Retry loading.") });
        const request: BootstrapRequest = {
          start: () => {
            if (epoch !== connectionEpoch()) {
              finish({ error: new Error("Thread loading was superseded. Retry loading.") });
              return;
            }
            try {
              void operation(signal).then(
                (value) => finish({ value }),
                (error: unknown) => finish({ error }),
              );
            } catch (error) {
              finish({ error });
            }
          },
        };
        signal.addEventListener("abort", cancel, { once: true });
        waiting.push(request);
        drain();
      }),
    timeoutMs,
  );
}
