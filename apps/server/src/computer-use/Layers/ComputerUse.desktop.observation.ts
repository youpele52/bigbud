import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import type { WindowRef } from "./ComputerUse.desktop.target.ts";
import { callDesktopTool } from "./ComputerUse.desktop.results.ts";

export function captureWindow(driver: CuaDriverShape, windowRef: WindowRef) {
  return callDesktopTool(driver, "get_window_state", {
    ...(windowRef.pid === undefined ? {} : { pid: windowRef.pid }),
    ...(windowRef.windowId === undefined ? {} : { window_id: windowRef.windowId }),
  });
}
