import { Data, Effect } from "effect";
import { makeKeyedCoalescingWorker } from "@bigbud/shared/KeyedCoalescingWorker";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";

class RemoteAgentMaintenanceError extends Data.TaggedError("RemoteAgentMaintenanceError") {}
let schedule: ((target: string) => void) | undefined;
let scheduleUpdate: ((target: string) => void) | undefined;

/** Cleanup is optional maintenance: losing a queued cleanup retains extra binaries, never ownership. */
export function scheduleRemoteAgentCleanup(target: string): void {
  schedule?.(target);
}

/** Notify automatic preparation after cleanup has a chance to free a slot. */
export function registerRemoteAgentUpdateTrigger(trigger: (target: string) => void): () => void {
  scheduleUpdate = trigger;
  return () => {
    if (scheduleUpdate === trigger) scheduleUpdate = undefined;
  };
}

export const makeRemoteAgentMaintenance = Effect.gen(function* () {
  const queued = new Set<string>();
  const manager = makeRemoteAgentInstallManager();
  const worker = yield* makeKeyedCoalescingWorker<string, true, never, never>({
    merge: () => true,
    process: (target) =>
      Effect.sleep(2_000).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => manager.cleanup(target),
            catch: () => new RemoteAgentMaintenanceError(),
          }),
        ),
        Effect.catch(() =>
          Effect.logWarning(
            "Remote agent binary cleanup deferred; recovery references remain retained.",
          ),
        ),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            queued.delete(target);
            scheduleUpdate?.(target);
          }),
        ),
      ),
  });
  const runFork = Effect.runForkWith(yield* Effect.services());
  const enqueue = (target: string) => {
    if (queued.size >= 128 && !queued.has(target)) return;
    queued.add(target);
    runFork(worker.enqueue(target, true));
  };
  schedule = enqueue;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (schedule === enqueue) schedule = undefined;
      queued.clear();
    }),
  );
  return { schedule: enqueue };
});
