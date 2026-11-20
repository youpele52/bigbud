/** Outcome of the Settings "Install command-line tool" action (D2). */
export type DesktopCommandLineToolResult =
  | {
      readonly status: "installed" | "updated";
      readonly launcherPath: string;
      /** Shell startup files and the Windows user Path are never edited by bigbud. */
      readonly pathHint: string | null;
    }
  | { readonly status: "existing-command"; readonly existingPath: string }
  | { readonly status: "unsupported"; readonly reason: string };

export interface DesktopCommandLineBridge {
  /**
   * Present only on platforms where the packaged launcher is verified. Development builds expose
   * it too but answer `unsupported`, since they have no stable bundled CLI to point at.
   */
  installCommandLineTool?: () => Promise<DesktopCommandLineToolResult>;
}
