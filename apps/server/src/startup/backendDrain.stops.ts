import * as Effect from "effect/Effect";

/**
 * Process-local registry of the real stop effects the upgrade drain runs before
 * any pane closes (W3.2 step 1). Long-lived owners register here for their own
 * lifetime (the relay route registers its lease set, the drain layer registers
 * monitors and provider sessions). A drain runs each step's stops in parallel
 * under one deadline; any failure or a missed deadline fails the step, so the
 * core never closes panes, exits masters or writes the marker.
 *
 * @module backendDrain.stops
 */
export type BackendDrainStopStep = "monitors" | "relays" | "providers";

/** Resolves to the number of resources stopped. */
export type BackendDrainStop = () => Promise<number>;

export interface BackendDrainStopReport {
  readonly step: BackendDrainStopStep;
  readonly stopped: number;
  readonly owners: number;
}

export const BACKEND_DRAIN_STOP_DEADLINE_MS = 10_000;

const stops: Record<BackendDrainStopStep, Set<BackendDrainStop>> = {
  monitors: new Set(),
  relays: new Set(),
  providers: new Set(),
};

export function registerBackendDrainStop(
  step: BackendDrainStopStep,
  stop: BackendDrainStop,
): () => void {
  stops[step].add(stop);
  return () => {
    stops[step].delete(stop);
  };
}

export class BackendDrainStopError extends Error {
  constructor(
    readonly step: BackendDrainStopStep,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BackendDrainStopError";
  }
}

/** Runs every registered stop for one step, bounded by `deadlineMs`. */
export const runBackendDrainStopStep = (
  step: BackendDrainStopStep,
  deadlineMs: number = BACKEND_DRAIN_STOP_DEADLINE_MS,
): Effect.Effect<BackendDrainStopReport, BackendDrainStopError> =>
  Effect.tryPromise({
    try: async () => {
      const owners = [...stops[step]];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new BackendDrainStopError(step, `Stopping ${step} exceeded ${deadlineMs} ms.`)),
          deadlineMs,
        );
      });
      try {
        const results = await Promise.race([
          Promise.allSettled(owners.map((stop) => stop())),
          deadline,
        ]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed)
          throw new BackendDrainStopError(step, `Stopping ${step} failed.`, {
            cause: failed.reason,
          });
        const stopped = results.reduce(
          (sum, result) => sum + (result.status === "fulfilled" ? result.value : 0),
          0,
        );
        return { step, stopped, owners: owners.length } satisfies BackendDrainStopReport;
      } finally {
        clearTimeout(timer);
      }
    },
    catch: (cause) =>
      cause instanceof BackendDrainStopError
        ? cause
        : new BackendDrainStopError(step, `Stopping ${step} failed.`, { cause }),
  });
