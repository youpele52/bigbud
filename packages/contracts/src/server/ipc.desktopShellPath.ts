/** Why the desktop shell refused to open or reveal a local path. */
export type DesktopShellPathRefusalReason =
  /** Not a string, empty, relative, contains NUL, or a UNC/device path on Windows. */
  | "invalid-path"
  | "not-found"
  /** Exists but cannot be resolved or inspected. */
  | "inaccessible"
  /** Neither a regular file nor a directory. */
  | "unsupported-entry"
  /** The OS reported an error opening the file (for example, no default app). */
  | "open-failed";

/** Outcome of `desktopBridge.openPath` / `desktopBridge.showItemInFolder`. */
export type DesktopShellPathResult =
  | { readonly status: "opened" }
  | {
      readonly status: "revealed";
      /** True when an open request was downgraded because the path would run or install. */
      readonly launchable: boolean;
    }
  | {
      readonly status: "refused";
      readonly reason: DesktopShellPathRefusalReason;
      /** OS error text for `open-failed`. */
      readonly message?: string;
    };

export interface DesktopShellPathBridge {
  /**
   * Opens a local absolute path in its default app. Executables, scripts, installers and app
   * bundles are revealed instead, never launched. Main window only: other windows get `null`.
   */
  openPath?: (path: string) => Promise<DesktopShellPathResult | null>;
  /** Reveals a local absolute path in Finder, Explorer or the file manager. Main window only. */
  showItemInFolder?: (path: string) => Promise<DesktopShellPathResult | null>;
}
