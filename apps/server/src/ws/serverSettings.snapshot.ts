import type { ServerSettings } from "@bigbud/contracts";

export interface SettingsSnapshot {
  readonly revision: number;
  readonly settings: ServerSettings;
}

/** Accepted settings invalidate request authority before asynchronous notifications. */
export class ServerSettingsSnapshot {
  private current: SettingsSnapshot | undefined;
  private readonly listeners = new Set<(snapshot: SettingsSnapshot) => void>();

  read = () => this.current;

  subscribe = (listener: (snapshot: SettingsSnapshot) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  accept(settings: ServerSettings): void {
    const snapshot = { revision: (this.current?.revision ?? 0) + 1, settings };
    this.current = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* One listener cannot retain another's stale authority. */
      }
    }
  }
}
