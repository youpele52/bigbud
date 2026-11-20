import { resolveDesktopReleaseIdentity } from "@bigbud/shared/desktopReleaseIdentity";
import { app } from "electron";

import { authorizedHandle } from "../window/ipcAuthorization";
import { installDesktopCommandLineTool } from "./commandLineTool";

/** Settings "Install command-line tool" (D2); only the main window may request it. */
export function registerCommandLineToolIpc(input: {
  readonly channel: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
}): void {
  authorizedHandle(input.channel, ["main"], () =>
    installDesktopCommandLineTool({
      isPackaged: input.isPackaged,
      platform: process.platform,
      execPath: process.execPath,
      resourcesPath: input.resourcesPath,
      environment: process.env,
      commandName: resolveDesktopReleaseIdentity(app.getVersion()).executableName,
    }),
  );
}
