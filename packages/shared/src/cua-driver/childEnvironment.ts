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
]);

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
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}
