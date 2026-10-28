/**
 * Desktop key-chord normalization shared by the selected legacy route and the
 * dormant v2 call plan. `"Command+Shift+A"` becomes `["cmd", "shift", "a"]`:
 * entries are trimmed and lowercased, `command`/`meta` map to `cmd`,
 * `control` maps to `ctrl`, and empty entries are dropped. One key maps to
 * `press_key`; several map to `hotkey`.
 */
export function normalizeKeyChord(key: string): ReadonlyArray<string> {
  return key
    .split("+")
    .map((entry) => {
      const normalized = entry.trim().toLowerCase();
      if (normalized === "command" || normalized === "meta") return "cmd";
      if (normalized === "control") return "ctrl";
      return normalized;
    })
    .filter((entry) => entry.length > 0);
}
