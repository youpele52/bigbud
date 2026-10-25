import type { OwnedV2Process } from "./ServerManager.child.ts";

/** Both signals invalidate availability; only physical proof authorizes terminal recovery. */
export function observeV2ProcessLifecycle(process: OwnedV2Process, notify: () => void) {
  const death = process.onDeath(notify);
  const unavailable = process.onUnavailable?.(notify);
  return () => {
    death();
    unavailable?.();
  };
}
