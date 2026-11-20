import type { DesktopShellPathResult } from "@bigbud/contracts/server/ipc.desktopShellPath.ts";
import { inspectSystemOpenPath } from "@bigbud/shared/systemOpenPath";
import { shell } from "electron";

import { desktopIpcChannels } from "../main.channels";
import { authorizedHandle, type IpcRoles } from "./ipcAuthorization";

/** Opening host files from search is a main-window action (plan §7, main-window role only). */
const SHELL_PATH_ROLES: IpcRoles = ["main"];

/**
 * Opens a validated local path in its default app. Electron calls the OS directly (no shell).
 * Launchable paths (executables, scripts, installers, app bundles) are revealed, never opened.
 */
export async function openSystemPath(rawPath: unknown): Promise<DesktopShellPathResult> {
  const inspection = await inspectSystemOpenPath(rawPath);
  if (!inspection.ok) return { status: "refused", reason: inspection.reason };
  if (inspection.launchable) {
    shell.showItemInFolder(inspection.realPath);
    return { status: "revealed", launchable: true };
  }
  const error = await shell.openPath(inspection.realPath);
  return error.length === 0
    ? { status: "opened" }
    : { status: "refused", reason: "open-failed", message: error };
}

/** Reveals a validated local path in Finder, Explorer or the file manager. */
export async function revealSystemPath(rawPath: unknown): Promise<DesktopShellPathResult> {
  const inspection = await inspectSystemOpenPath(rawPath);
  if (!inspection.ok) return { status: "refused", reason: inspection.reason };
  shell.showItemInFolder(inspection.realPath);
  return { status: "revealed", launchable: inspection.launchable };
}

export function registerShellPathIpc(): void {
  authorizedHandle(desktopIpcChannels.openPath, SHELL_PATH_ROLES, (_event, rawPath: unknown) =>
    openSystemPath(rawPath),
  );
  authorizedHandle(
    desktopIpcChannels.showItemInFolder,
    SHELL_PATH_ROLES,
    (_event, rawPath: unknown) => revealSystemPath(rawPath),
  );
}
