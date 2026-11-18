import type { MobileTransportEvidence, MobileConnectionState } from "./mobileConnection.logic";

export type MobileResumeAction = "expire" | "restart" | "none";

/**
 * What to do when the page may have come back (online, focus, or shown):
 * expire a lapsed session, restart a dead transport, or leave a live or
 * already-retrying connection to its own controller. A hidden page does
 * nothing; it is handled when it is shown again.
 */
export function resolveMobileResumeAction(input: {
  readonly visible: boolean;
  readonly sessionExpired: boolean;
  readonly transport: MobileTransportEvidence;
  readonly authorization?: MobileConnectionState["authorization"];
}): MobileResumeAction {
  if (input.authorization === "explicitly-rejected") return "none";
  if (!input.visible) return "none";
  if (input.sessionExpired) return "expire";
  return input.transport === "closed" || input.transport === "exhausted" ? "restart" : "none";
}

export interface MobileResumeTargets {
  readonly window: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  readonly document: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}

/**
 * Wires browser resume signals to the connection. Returns the removal
 * function; every listener added here is removed by it.
 */
export function installMobileResumeListeners(
  targets: MobileResumeTargets,
  handlers: {
    readonly onOnline: () => void;
    readonly onOffline: () => void;
    readonly onResume: () => void;
  },
): () => void {
  const subscriptions: ReadonlyArray<
    readonly [MobileResumeTargets[keyof MobileResumeTargets], string, () => void]
  > = [
    [targets.window, "online", handlers.onOnline],
    [targets.window, "offline", handlers.onOffline],
    [targets.window, "focus", handlers.onResume],
    [targets.document, "visibilitychange", handlers.onResume],
  ];
  for (const [target, type, listener] of subscriptions) target.addEventListener(type, listener);
  return () => {
    for (const [target, type, listener] of subscriptions) {
      target.removeEventListener(type, listener);
    }
  };
}

export function canRestartMobileConnection(state: MobileConnectionState): boolean {
  return !state.expired && state.authorization !== "explicitly-rejected";
}
