/**
 * The saved "Run terminals in the background host" setting, read once at startup.
 *
 * The host is chosen when the server starts, so the saved value is latched on first read and a
 * change applies after a restart. An explicit `BIGBUD_TERMINAL_HOST` environment value always
 * wins over the saved setting.
 *
 * @module localTerminalHost.preference
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let latched: boolean | undefined;

/** Reads `terminalHostEnabled` from settings.json; a missing or unreadable file means off. */
export function readTerminalHostPreference(
  settingsPath: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean {
  try {
    const parsed: unknown = JSON.parse(readFile(settingsPath));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).terminalHostEnabled === true
    );
  } catch {
    return false;
  }
}

/** Latches the saved preference for this process. The first call wins; later calls reuse it. */
export function latchTerminalHostPreference(stateDir: string): boolean {
  latched ??= readTerminalHostPreference(join(stateDir, "settings.json"));
  return latched;
}

/** The latched preference, or off when startup has not read it yet. */
export function latchedTerminalHostPreference(): boolean {
  return latched ?? false;
}

/** Test-only: forget the latched value. */
export function resetTerminalHostPreferenceForTest(): void {
  latched = undefined;
}
