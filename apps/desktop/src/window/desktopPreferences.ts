import * as FS from "node:fs";
import * as Path from "node:path";

import type { FloatingAssistantCaller } from "@bigbud/contracts/server/ipc.ts";

export interface DesktopPreferences {
  version: 1;
  floatingAssistantEnabled: boolean;
  floatingAssistantCaller: FloatingAssistantCaller;
  mascotVisible: boolean;
  mascotBounds: { x: number; y: number } | null;
}

const defaults: DesktopPreferences = {
  version: 1,
  floatingAssistantEnabled: false,
  floatingAssistantCaller: "matte",
  mascotVisible: true,
  mascotBounds: null,
};

function isFinitePoint(value: unknown): value is { x: number; y: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isFinite((value as { x?: unknown }).x) &&
    Number.isFinite((value as { y?: unknown }).y)
  );
}

function decode(value: unknown): DesktopPreferences | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Partial<DesktopPreferences>;
  if (state.version !== 1 || typeof state.floatingAssistantEnabled !== "boolean") return null;
  if (typeof state.mascotVisible !== "boolean") return null;
  if (state.mascotBounds !== null && !isFinitePoint(state.mascotBounds)) return null;
  return {
    ...state,
    // The legacy "mascot" caller and invalid values migrate to the default matte-black hand.
    floatingAssistantCaller:
      state.floatingAssistantCaller === "logo" || state.floatingAssistantCaller === "chrome"
        ? state.floatingAssistantCaller
        : "matte",
  } as DesktopPreferences;
}

export class DesktopPreferencesStore {
  readonly #path: string;
  #state: DesktopPreferences;

  constructor(
    userDataPath: string,
    private readonly log: (message: string) => void,
  ) {
    this.#path = Path.join(userDataPath, "desktop-preferences.json");
    this.#state = this.read();
  }

  get(): DesktopPreferences {
    return this.#state;
  }

  update(next: Partial<Omit<DesktopPreferences, "version">>): DesktopPreferences {
    this.#state = { ...this.#state, ...next, version: 1 };
    try {
      const temporaryPath = `${this.#path}.tmp`;
      FS.writeFileSync(temporaryPath, JSON.stringify(this.#state), "utf8");
      FS.renameSync(temporaryPath, this.#path);
    } catch (error) {
      this.log(
        `desktop preferences write failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    return this.#state;
  }

  private read(): DesktopPreferences {
    try {
      const decoded = decode(JSON.parse(FS.readFileSync(this.#path, "utf8")));
      return decoded ?? defaults;
    } catch {
      return defaults;
    }
  }
}
