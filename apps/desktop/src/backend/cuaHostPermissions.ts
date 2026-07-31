import { systemPreferences } from "electron";

export function requestHostAccessibilityPermission(): boolean | null {
  if (process.platform !== "darwin") return null;
  return systemPreferences.isTrustedAccessibilityClient(true);
}
