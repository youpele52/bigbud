import type { ComputerUseAction } from "@bigbud/contracts";
import { Effect, Layer } from "effect";

import { BrowserManager } from "../../browser/Services/BrowserManager.ts";
import { executeBrowserComputerUse } from "./ComputerUse.browser.ts";
import { executeDesktopComputerUse } from "./ComputerUse.desktop.ts";
import { CuaDriver } from "../Services/CuaDriver.ts";
import { ComputerUse, type ComputerUseShape } from "../Services/ComputerUse.ts";

function resolveSurface(action: ComputerUseAction): "browser" | "desktop" {
  switch (action.action) {
    case "list_windows":
    case "list_apps":
    case "check_permissions":
    case "doctor":
    case "launch_app":
    case "focus_app":
    case "get_accessibility_tree":
      return "desktop";
    default:
      return action.surface ?? "browser";
  }
}

export function isDesktopSurfaceAction(action: ComputerUseAction): boolean {
  return resolveSurface(action) === "desktop";
}

export const ComputerUseLive = Layer.effect(
  ComputerUse,
  Effect.gen(function* () {
    const browser = yield* BrowserManager;
    const cuaDriver = yield* CuaDriver;

    const execute: ComputerUseShape["execute"] = (threadId, action) =>
      resolveSurface(action) === "desktop"
        ? executeDesktopComputerUse(threadId, cuaDriver, action)
        : executeBrowserComputerUse(browser, threadId, action);

    return { execute, dispose: cuaDriver.dispose };
  }),
);
