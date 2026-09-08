import {
  resolvePackagedDesktopSupervisorPlan,
  resolvePackagedOpencodeBinaryPlan,
  resolvePackagedWorkspaceAgentPlan,
} from "../env/pathResolver.platform";
import type { WindowsReplaceabilityTarget } from "../backend/windowsFileReplaceability";

export function resolveWindowsUpdateTargets(input: {
  readonly cuaDriverPath: string | null;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
}): ReadonlyArray<WindowsReplaceabilityTarget> {
  // Keep this inventory to executables that bigbud resolves and launches from
  // its installation. The running Electron executable is intentionally absent:
  // NSIS owns replacing its parent process after the updater handoff.
  if (input.platform !== "win32") return [];
  const targets: WindowsReplaceabilityTarget[] = [];
  if (input.cuaDriverPath) {
    targets.push({ label: "the CUA driver", path: input.cuaDriverPath });
  }
  if (!input.isPackaged) return targets;
  targets.push(
    {
      label: "the packaged OpenCode runtime",
      path: resolvePackagedOpencodeBinaryPlan(input.platform, input.resourcesPath).binaryPath,
    },
    {
      label: "the packaged workspace agent",
      path: resolvePackagedWorkspaceAgentPlan(input.platform, input.resourcesPath).binaryPath,
    },
    {
      label: "the packaged desktop supervisor",
      path: resolvePackagedDesktopSupervisorPlan(input.platform, input.resourcesPath).binaryPath,
    },
  );
  return targets;
}
