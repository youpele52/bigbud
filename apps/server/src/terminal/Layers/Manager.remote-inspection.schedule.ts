import { Effect } from "effect";
import { TerminalAgentInspectionError } from "./Manager.agentDetection.ts";
import type { RemoteTerminalProcessInspector } from "./Manager.remote-inspection.ts";

export const REMOTE_IDENTITY_SAMPLE_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_TARGETS = 256;
const FORGET_AFTER_MS = 5 * 60_000;

/** Per-manager scheduling: no overlaps, no cached snapshots masquerading as fresh misses. */
export function scheduleRemoteTerminalInspection(
  inspect: RemoteTerminalProcessInspector,
  now: () => number = () => performance.now(),
): RemoteTerminalProcessInspector {
  const targets = new Map<
    string,
    {
      running: boolean;
      nextAt: number;
      lastAttemptAt: number;
      failures: number;
    }
  >();
  const deferred = () => new TerminalAgentInspectionError({ message: "Remote inspection not due" });
  return (target) =>
    Effect.suspend(() => {
      const time = now();
      let entry = targets.get(target);
      if (!entry) {
        if (targets.size >= MAX_TARGETS) {
          for (const [key, value] of targets) {
            if (!value.running && time - value.lastAttemptAt >= FORGET_AFTER_MS)
              targets.delete(key);
          }
          if (targets.size >= MAX_TARGETS) return Effect.fail(deferred());
        }
        entry = { running: false, nextAt: 0, lastAttemptAt: time, failures: 0 };
        targets.set(target, entry);
      }
      if (entry.running || time < entry.nextAt) return Effect.fail(deferred());
      entry.running = true;
      entry.lastAttemptAt = time;
      const current = entry;
      return inspect(target).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            current.failures = 0;
            current.nextAt = now() + REMOTE_IDENTITY_SAMPLE_MS;
          }),
        ),
        Effect.onError(() =>
          Effect.sync(() => {
            current.failures = Math.min(current.failures + 1, 5);
            current.nextAt = now() + Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** (current.failures - 1));
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            current.running = false;
          }),
        ),
      );
    });
}
