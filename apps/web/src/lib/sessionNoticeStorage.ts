import type { StateStorage } from "zustand/middleware";

import { createMemoryStorage } from "./storage";

/** Storage failures must never prevent a presentation from being dismissed. */
export function createSessionNoticeStorage(): StateStorage {
  const fallback = createMemoryStorage();
  try {
    const storage = typeof window !== "undefined" ? window.localStorage : null;
    return {
      getItem: (key) => {
        try {
          return storage?.getItem(key) ?? fallback.getItem(key);
        } catch {
          return fallback.getItem(key);
        }
      },
      setItem: (key, value) => {
        fallback.setItem(key, value);
        try {
          storage?.setItem(key, value);
        } catch {
          // The current renderer retains suppression when durable storage is unavailable.
        }
      },
      removeItem: (key) => {
        fallback.removeItem(key);
        try {
          storage?.removeItem(key);
        } catch {
          // The in-memory fallback remains usable.
        }
      },
    };
  } catch {
    return fallback;
  }
}
