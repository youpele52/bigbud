/**
 * The one computer-use surface rule, shared by the selected legacy route and
 * the dormant v2 classifier: desktop-only actions are always desktop; every
 * other action is desktop only when `surface: "desktop"` is explicit, so an
 * omitted surface keeps today's browser default.
 */
export type ComputerUseSurface = "browser" | "desktop";

export const DESKTOP_ONLY_COMPUTER_USE_ACTIONS: ReadonlySet<string> = new Set([
  "list_windows",
  "list_apps",
  "check_permissions",
  "doctor",
  "launch_app",
  "focus_app",
  "get_accessibility_tree",
]);

export const isComputerUseSurface = (value: unknown): value is ComputerUseSurface =>
  value === "browser" || value === "desktop";

export function resolveComputerUseSurface(
  action: string,
  surface: ComputerUseSurface | undefined,
): ComputerUseSurface {
  return DESKTOP_ONLY_COMPUTER_USE_ACTIONS.has(action) ? "desktop" : (surface ?? "browser");
}
