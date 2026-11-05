import type { ComputerUseAction, ThreadId } from "@bigbud/contracts";
import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import { executeDesktopComputerUse } from "./ComputerUse.desktop.ts";
import { createDesktopTargets } from "./ComputerUse.desktop.interaction.ts";

/** Exercise the user-selected foreground path independently of the new background default. */
export function executeForegroundDesktopComputerUse(
  threadId: ThreadId,
  driver: CuaDriverShape,
  action: ComputerUseAction,
) {
  return executeDesktopComputerUse(threadId, driver, action, undefined, {
    deliveryMode: "foreground",
    targets: createDesktopTargets(),
  });
}
