import type { ThreadId, ComputerUseResult } from "@bigbud/contracts";
import { Effect } from "effect";

import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import {
  backgroundUnavailable,
  type DesktopInteraction,
} from "./ComputerUse.desktop.interaction.ts";
import {
  desktopWindows,
  findRunningDesktopApp,
  toDesktopTarget,
} from "./ComputerUse.desktop.target.ts";
import { toError, callDesktopTool, mutationSummary } from "./ComputerUse.desktop.results.ts";

/** Select an existing window without launching, activating, or raising an application. */
export const selectBackgroundTarget = Effect.fn("selectBackgroundTarget")(function* (
  threadId: ThreadId,
  driver: CuaDriverShape,
  selector: {
    readonly pid?: number | undefined;
    readonly windowId?: number | undefined;
    readonly name?: string | undefined;
  },
  interaction: DesktopInteraction,
) {
  interaction.targets.delete(threadId);
  if (selector.pid === undefined && !selector.name && selector.windowId === undefined) {
    return yield* backgroundUnavailable("Desktop focus_app requires either pid or name.");
  }
  const pid =
    selector.pid ??
    (selector.name ? (yield* findRunningDesktopApp(driver, selector.name))?.pid : undefined);
  if (selector.name && pid === undefined) {
    return yield* backgroundUnavailable(
      "The requested app is not running or is ambiguous. Open it manually first.",
    );
  }
  const result = yield* driver
    .callTool("list_windows", {})
    .pipe(Effect.mapError((cause) => toError(cause, "Failed to select a background window.")));
  const matches = desktopWindows(result.structuredContent).filter(
    (window) =>
      (pid === undefined || window.pid === pid) &&
      (selector.windowId === undefined || window.windowId === selector.windowId),
  );
  if (matches.length !== 1) {
    return yield* backgroundUnavailable(
      "The background target is missing or ambiguous. Use list_windows and select an exact pid and windowId.",
    );
  }
  const window = matches[0]!;
  interaction.targets.set(threadId, window);
  return window;
});

/** macOS launch_app explicitly guarantees background launch and returns its window identities. */
export const launchBackgroundApp = Effect.fn("launchBackgroundApp")(function* (
  threadId: ThreadId,
  driver: CuaDriverShape,
  name: string,
  interaction: DesktopInteraction,
) {
  interaction.targets.delete(threadId);
  if (process.platform !== "darwin") {
    return yield* backgroundUnavailable(
      "Background app launch is not qualified on this platform. Open the app manually first.",
    );
  }
  const result = yield* callDesktopTool(driver, "launch_app", { name });
  const windows = desktopWindows(result.structuredContent);
  const window = windows.length === 1 ? windows[0]! : undefined;
  if (window) interaction.targets.set(threadId, window);
  return {
    surface: "desktop",
    action: "launch_app",
    summary: `${mutationSummary("launch_app", JSON.stringify(name), result.actionOutcome)} ${
      window
        ? "Selected its window for background interaction."
        : "No unique target window was returned. Use list_windows and focus_app to select one; do not repeat the launch."
    }`,
    ...(window ? { desktopTarget: toDesktopTarget(window) } : {}),
    ...(result.detailsJson ? { detailsJson: result.detailsJson } : {}),
    ...(result.actionOutcome ? { actionOutcome: result.actionOutcome } : {}),
  } satisfies ComputerUseResult;
});
