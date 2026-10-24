import { OPENCODE_RETAINED_HISTORY_ADVISORY_ID } from "@bigbud/shared/opencodeAdvisory";

export const RETAINED_HISTORY_DISMISSAL_KEY = `bigbud:provider-advisory:${OPENCODE_RETAINED_HISTORY_ADVISORY_ID}:dismissed`;

/** One store per JS app runtime; reload/new tabs start a new runtime. */
export function createRetainedHistoryAdvisoryState(
  getStorage: () => Pick<Storage, "getItem" | "setItem"> | undefined = () =>
    globalThis.window?.localStorage,
) {
  let initialized = false;
  let dismissed = false;
  let startupDismissed = false;
  let notified = false;
  const listeners = new Set<() => void>();

  function readDismissed() {
    try {
      return getStorage()?.getItem(RETAINED_HISTORY_DISMISSAL_KEY) === "true";
    } catch {
      // Private browsing and storage denial keep the in-memory dismissal usable.
      return false;
    }
  }

  function getSnapshot() {
    if (!initialized) {
      initialized = true;
      startupDismissed = dismissed = readDismissed();
    }
    return dismissed;
  }

  function syncFromStorage(event: StorageEvent) {
    if (event.key !== RETAINED_HISTORY_DISMISSAL_KEY || dismissed || !readDismissed()) return;
    dismissed = true;
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) globalThis.window?.addEventListener("storage", syncFromStorage);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) globalThis.window?.removeEventListener("storage", syncFromStorage);
      };
    },
    dismiss() {
      getSnapshot();
      dismissed = true;
      try {
        getStorage()?.setItem(RETAINED_HISTORY_DISMISSAL_KEY, "true");
      } catch {
        // Retain dismissal across thread remounts even if persistence is unavailable.
      }
      for (const listener of listeners) listener();
    },
    claimStartupToast() {
      getSnapshot();
      if (!startupDismissed || notified) return false;
      notified = true;
      return true;
    },
  };
}

export const retainedHistoryAdvisoryState = createRetainedHistoryAdvisoryState();
