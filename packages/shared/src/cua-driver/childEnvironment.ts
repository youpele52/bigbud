import { cuaDriverCursorThemeDirectory } from "./cursorTheme";

export const CUA_DRIVER_STATE_HOME_KEY = "BIGBUD_CUA_STATE_HOME";

const REQUIRED_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
  CUA_DRIVER_STATE_HOME_KEY,
]);

/**
 * bigbud's private Driver state directory (`BIGBUD_CUA_STATE_HOME`) is the only
 * key carried in the daemon env into the backend (so terminals and provider
 * CLIs never inherit Driver overrides); `makeCuaDriverChildEnvironment`
 * derives the upstream overrides from it for every Driver child (daemon,
 * activation run, status and manifest commands, MCP proxy, reset commands).
 * Driver-owned state is moved into `stateHome` with the upstream overrides
 * below. `HOME` itself stays real: `list_apps` and
 * `launch_app` discover `~/Applications` through it on both versions
 * (0.38 `platform-macos/src/apps/mod.rs:190-193,672-680,826-827`;
 * 0.9.1 `apps/mod.rs:282-288,380-381`).
 *
 * - `CUA_DRIVER_RS_HOME`: 0.38 Computer History root, so the persisted
 *   `admission.json` is read from here and never from a standalone install
 *   (`history_runtime.rs:396-398,424-429`); skills/extensions/release-channel
 *   state (`skills.rs:148-150`, `extension_manager.rs:1052`,
 *   `release_channel.rs:125`). 0.9.1 reads it for skills only (`skills.rs:145,165`).
 * - `CUA_DRIVER_TELEMETRY_HOME`: telemetry config and install markers,
 *   replacing `~/.cua-driver` (0.38 `telemetry.rs:2240-2244`;
 *   0.9.1 `telemetry.rs:46,1718-1722`).
 * - `CUA_DRIVER_CURSOR_THEME_DIR`: 0.38 installed cursor-theme store, replacing
 *   `~/Library/Application Support/Cua Driver/cursor-themes` (cursor-overlay
 *   `theme_artifact.rs` `theme_store_root`), so bigbud's theme is private.
 *   0.9.1 has no compiled themes and ignores it.
 */
export function cuaDriverStateEnvironment(stateHome: string): Record<string, string> {
  return { [CUA_DRIVER_STATE_HOME_KEY]: stateHome };
}

function driverStateOverrides(stateHome: string): Record<string, string> {
  return {
    CUA_DRIVER_RS_HOME: stateHome,
    CUA_DRIVER_TELEMETRY_HOME: stateHome,
    CUA_DRIVER_CURSOR_THEME_DIR: cuaDriverCursorThemeDirectory(stateHome),
  };
}

export function makeCuaDriverChildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (REQUIRED_KEYS.has(key) || key.startsWith("LC_"))) {
      environment[key] = value;
    }
  }
  environment.CUA_DRIVER_RS_TELEMETRY_ENABLED = "false";
  environment.CUA_DRIVER_RS_UPDATE_CHECK = "false";
  const stateHome = overrides[CUA_DRIVER_STATE_HOME_KEY] ?? source[CUA_DRIVER_STATE_HOME_KEY];
  if (stateHome) Object.assign(environment, driverStateOverrides(stateHome));
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  // Background drag must never escalate because of inherited/user configuration.
  // Explicit delivery_mode: foreground remains available through Computer Use settings.
  environment.CUA_DRIVER_ALLOW_BRIEF_FOREGROUND = "false";
  return environment;
}
