import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { app } from "electron";

import { resolveAboutCommitHash } from "./env/pathResolver";

type LinuxDesktopNamedApp = Electron.App & {
  setDesktopName?: (desktopName: string) => void;
};

export interface DesktopAppIdentity {
  readonly appDisplayName: string;
  readonly appUserModelId: string;
  readonly legacyUserDataDirName: string;
  readonly linuxDesktopEntryName: string;
  readonly resolveIconPath: (ext: "ico" | "icns" | "png") => string | null;
  readonly rootDir: string;
  readonly userDataDirName: string;
}

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from `productName` in
 * package.json, which would produce directories with spaces and parentheses.
 * This is
 * unfriendly for shell usage and violates Linux naming conventions.
 *
 * We override it to a clean lowercase name (`bigbud`). If the legacy
 * `T3 Code (...)` directory already exists we keep using it so existing users don't
 * lose their Chromium profile data (localStorage, cookies, sessions).
 */
export function resolveUserDataPath({
  legacyUserDataDirName,
  userDataDirName,
}: Pick<DesktopAppIdentity, "legacyUserDataDirName" | "userDataDirName">): string {
  const appDataBase =
    process.platform === "win32"
      ? process.env.APPDATA || Path.join(OS.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? Path.join(OS.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || Path.join(OS.homedir(), ".config");

  const legacyPath = Path.join(appDataBase, legacyUserDataDirName);
  if (FS.existsSync(legacyPath)) {
    return legacyPath;
  }

  return Path.join(appDataBase, userDataDirName);
}

export function configureAppIdentity(identity: DesktopAppIdentity): void {
  app.setName(identity.appDisplayName);
  const commitHash = resolveAboutCommitHash(identity.rootDir);
  app.setAboutPanelOptions({
    applicationName: identity.appDisplayName,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(identity.appUserModelId);
  }

  if (process.platform === "linux") {
    (app as LinuxDesktopNamedApp).setDesktopName?.(identity.linuxDesktopEntryName);
  }

  if (process.platform === "darwin" && app.dock) {
    // Packaged macOS apps already get their Dock icon from the app bundle.
    if (app.isPackaged) {
      return;
    }

    const iconPath = identity.resolveIconPath("png");
    if (iconPath) {
      app.dock.setIcon(iconPath);
    }
  }
}
