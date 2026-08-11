import type { PluginInstallation } from "@bigbud/contracts";

export type PluginDetailAction = "install" | "update" | "uninstall";

export function pluginDetailAction(
  itemRevision: string,
  installation: PluginInstallation | undefined,
): PluginDetailAction {
  if (!installation) return "install";
  return installation.revision === itemRevision ? "uninstall" : "update";
}

export function pluginDetailActionLabel(action: PluginDetailAction): string {
  if (action === "install") return "Install plugin";
  if (action === "update") return "Update plugin";
  return "Uninstall plugin";
}

export function pluginDetailActionRequiresConfirmation(action: PluginDetailAction): boolean {
  return action === "uninstall";
}

export function pluginDetailMutationErrorTitle(action: PluginDetailAction): string {
  if (action === "install") return "Could not install plugin";
  if (action === "update") return "Could not update plugin";
  return "Could not uninstall plugin";
}

export function pluginErrorDescription(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}
