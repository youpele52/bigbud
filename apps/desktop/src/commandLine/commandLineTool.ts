import * as OS from "node:os";

import type { DesktopCommandLineToolResult } from "@bigbud/contracts";
import {
  installCommandLineLauncher,
  resolveCommandLineLauncherTarget,
} from "@bigbud/shared/commandLineLauncher";

import { packagedBackendEntry } from "../env/backendEntry";
import { isCommandLineToolOffered } from "./commandLineTool.gate";

/** Install the launcher for this packaged app; development builds have no stable bundle. */
export function installDesktopCommandLineTool(input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly resourcesPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Release identity executable name: `bigbud`, or `bigbud-<channel>` for prereleases. */
  readonly commandName?: string;
  readonly homeDir?: string;
}): DesktopCommandLineToolResult {
  if (!input.isPackaged) {
    return { status: "unsupported", reason: "Available in the installed bigbud app." };
  }
  if (!isCommandLineToolOffered(input.platform)) {
    return { status: "unsupported", reason: "Not yet available on this platform." };
  }
  return installCommandLineLauncher({
    platform: input.platform,
    homeDir: input.homeDir ?? OS.homedir(),
    pathValue: input.environment.PATH ?? "",
    ...(input.commandName ? { commandName: input.commandName } : {}),
    target: resolveCommandLineLauncherTarget({
      platform: input.platform,
      runtime: input.execPath,
      serverEntry: packagedBackendEntry(input.resourcesPath),
      environment: input.environment,
    }),
  });
}
