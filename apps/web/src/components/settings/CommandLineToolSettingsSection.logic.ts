import type { DesktopCommandLineToolResult } from "@bigbud/contracts";

/** Toast for each outcome: green installed, amber when the person still has a step, red fails. */
export function commandLineToolToast(result: DesktopCommandLineToolResult) {
  switch (result.status) {
    case "installed":
    case "updated":
      return {
        type: result.pathHint ? ("warning" as const) : ("success" as const),
        title:
          result.status === "installed"
            ? "Command-line tool installed"
            : "Command-line tool updated",
        description: result.pathHint
          ? `Created ${result.launcherPath}. ${result.pathHint}`
          : `Run \`bigbud --help\` in a new terminal.`,
      };
    case "existing-command":
      return {
        type: "warning" as const,
        title: "A bigbud command already exists",
        description: `${result.existingPath} was left unchanged.`,
      };
    case "unsupported":
      return {
        type: "error" as const,
        title: "Unable to install the command-line tool",
        description: result.reason,
      };
  }
}
