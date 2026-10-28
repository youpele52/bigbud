import type { ComputerUseAction, ComputerUseResult, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { normalizeKeyChord } from "@bigbud/shared/computer-use/keys";
import { normalizeScroll } from "@bigbud/shared/computer-use/scroll";

import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import { ComputerUseError } from "../Services/ComputerUse.ts";
import { guardComputerUseTarget } from "../computerUseSafety.ts";
import {
  callDesktopTool,
  firstText,
  mutationSummary,
  stringify,
  toError,
  type DesktopToolResult,
} from "./ComputerUse.desktop.results.ts";

import {
  currentDesktopWindow,
  findRunningDesktopApp,
  toDesktopTarget,
} from "./ComputerUse.desktop.target.ts";
import { captureWindow } from "./ComputerUse.desktop.observation.ts";

export const executeDesktopAction = (
  _threadId: ThreadId,
  driver: CuaDriverShape,
  action: ComputerUseAction,
): Effect.Effect<ComputerUseResult, ComputerUseError> =>
  Effect.gen(function* () {
    switch (action.action) {
      case "list_windows": {
        const result = yield* driver
          .callTool("list_windows", {})
          .pipe(Effect.mapError((cause) => toError(cause, "Failed to list desktop windows.")));
        return {
          surface: "desktop",
          action: action.action,
          summary: "Listed desktop windows.",
          ...(stringify(result.structuredContent)
            ? { detailsJson: stringify(result.structuredContent) }
            : {}),
        } satisfies ComputerUseResult;
      }
      case "list_apps": {
        const result = yield* driver
          .callTool("list_apps", {})
          .pipe(Effect.mapError((cause) => toError(cause, "Failed to list desktop apps.")));
        return {
          surface: "desktop",
          action: action.action,
          summary: "Listed desktop apps.",
          ...(stringify(result.structuredContent)
            ? { detailsJson: stringify(result.structuredContent) }
            : {}),
        } satisfies ComputerUseResult;
      }
      case "doctor": {
        const doctor = yield* driver
          .runDoctor()
          .pipe(
            Effect.mapError((cause) =>
              toError(cause, "Failed to run desktop automation diagnostics."),
            ),
          );
        return {
          surface: "desktop",
          action: action.action,
          summary: "Collected desktop automation diagnostics.",
          diagnostics: {
            status: "ready",
            message: "cua-driver diagnostics completed.",
            detailsJson: doctor,
          },
        } satisfies ComputerUseResult;
      }
      case "check_permissions": {
        const result = yield* driver
          .callTool(
            "check_permissions",
            action.prompt === undefined ? {} : { prompt: action.prompt },
          )
          .pipe(Effect.mapError((cause) => toError(cause, "Failed to check desktop permissions.")));
        return {
          surface: "desktop",
          action: action.action,
          summary: "Checked desktop automation permissions.",
          diagnostics: {
            status: "ready",
            message: firstText(result) ?? "Desktop permissions inspected.",
            ...(stringify(result.structuredContent)
              ? { detailsJson: stringify(result.structuredContent) }
              : {}),
          },
        } satisfies ComputerUseResult;
      }
      case "launch_app": {
        const result = yield* callDesktopTool(driver, "launch_app", {
          name: action.name,
        });
        return {
          surface: "desktop",
          action: action.action,
          summary: mutationSummary("launch_app", JSON.stringify(action.name), result.actionOutcome),
          ...(result.detailsJson ? { detailsJson: result.detailsJson } : {}),
          ...(result.actionOutcome ? { actionOutcome: result.actionOutcome } : {}),
        } satisfies ComputerUseResult;
      }
      case "focus_app": {
        if (action.pid !== undefined) {
          const result = yield* callDesktopTool(driver, "bring_to_front", {
            pid: action.pid,
            ...(action.windowId === undefined ? {} : { window_id: action.windowId }),
          });
          return {
            surface: "desktop",
            action: action.action,
            summary: mutationSummary("focus_app", `PID ${action.pid}`, result.actionOutcome),
            ...(result.detailsJson ? { detailsJson: result.detailsJson } : {}),
            ...(result.actionOutcome ? { actionOutcome: result.actionOutcome } : {}),
          } satisfies ComputerUseResult;
        }
        if (action.name) {
          const runningApp = yield* findRunningDesktopApp(driver, action.name);
          const result = runningApp
            ? yield* callDesktopTool(driver, "bring_to_front", { pid: runningApp.pid })
            : yield* callDesktopTool(driver, "launch_app", { name: action.name });
          return {
            surface: "desktop",
            action: action.action,
            summary: mutationSummary(
              "focus_app",
              JSON.stringify(action.name),
              result.actionOutcome,
            ),
            ...(result.detailsJson ? { detailsJson: result.detailsJson } : {}),
            ...(result.actionOutcome ? { actionOutcome: result.actionOutcome } : {}),
          } satisfies ComputerUseResult;
        }
        return yield* new ComputerUseError({
          message: "Desktop focus_app requires either pid or name.",
        });
      }
      case "get_accessibility_tree": {
        const baseWindow =
          action.pid !== undefined || action.windowId !== undefined
            ? {
                ...(action.pid === undefined ? {} : { pid: action.pid }),
                ...(action.windowId === undefined ? {} : { windowId: action.windowId }),
              }
            : ((yield* currentDesktopWindow(driver)) ?? {});
        const result = yield* callDesktopTool(driver, "get_accessibility_tree", {});
        return {
          surface: "desktop",
          action: action.action,
          summary: "Captured the desktop accessibility tree.",
          desktopTarget: toDesktopTarget(baseWindow),
          ...(result.text ? { treeText: result.text } : {}),
          ...(result.detailsJson ? { detailsJson: result.detailsJson } : {}),
        } satisfies ComputerUseResult;
      }
      default:
        break;
    }

    const windowRef = yield* currentDesktopWindow(driver);
    if (!windowRef) {
      return yield* new ComputerUseError({
        message: "No active desktop window could be resolved.",
      });
    }

    const targetSafetyViolation = guardComputerUseTarget({
      action,
      surface: "desktop",
      appName: windowRef.appName ?? null,
      title: windowRef.title ?? null,
    });
    if (targetSafetyViolation) {
      return yield* new ComputerUseError({ message: targetSafetyViolation });
    }

    if (action.action === "capture" || action.action === "get_page_info") {
      const captured = yield* captureWindow(driver, windowRef);
      return {
        surface: "desktop",
        action: action.action,
        summary:
          action.action === "capture"
            ? `Captured ${JSON.stringify(windowRef.title ?? windowRef.appName ?? "the active window")}.`
            : `Read desktop state for ${JSON.stringify(windowRef.title ?? windowRef.appName ?? "the active window")}.`,
        desktopTarget: toDesktopTarget(windowRef),
        ...(captured.screenshot ? { screenshot: captured.screenshot } : {}),
        ...(captured.text ? { treeText: captured.text } : {}),
        ...(captured.detailsJson ? { detailsJson: captured.detailsJson } : {}),
      } satisfies ComputerUseResult;
    }

    let mutationResult: DesktopToolResult | undefined;
    if (action.action === "wait") {
      yield* Effect.sleep(`${action.durationMs} millis`);
    } else if (action.action === "click") {
      mutationResult = yield* callDesktopTool(driver, "click", {
        pid: windowRef.pid,
        window_id: windowRef.windowId,
        x: action.x,
        y: action.y,
        button: action.button ?? "left",
      });
    } else if (action.action === "drag") {
      mutationResult = yield* callDesktopTool(driver, "drag", {
        pid: windowRef.pid,
        window_id: windowRef.windowId,
        from_x: action.startX,
        from_y: action.startY,
        to_x: action.endX,
        to_y: action.endY,
      });
    } else if (action.action === "scroll") {
      const scroll = normalizeScroll(action.deltaX, action.deltaY);
      if (scroll === null) {
        return yield* new ComputerUseError({
          message: "Desktop scroll requires a non-zero delta.",
        });
      }
      mutationResult = yield* callDesktopTool(driver, "scroll", {
        pid: windowRef.pid,
        window_id: windowRef.windowId,
        direction: scroll.direction,
        amount: scroll.amount,
        ...(action.x === undefined ? {} : { x: action.x }),
        ...(action.y === undefined ? {} : { y: action.y }),
      });
    } else if (action.action === "type") {
      mutationResult = yield* callDesktopTool(driver, "type_text", {
        pid: windowRef.pid,
        window_id: windowRef.windowId,
        text: action.text,
      });
    } else if (action.action === "key") {
      const keys = normalizeKeyChord(action.key);
      if (keys.length === 0) {
        return yield* new ComputerUseError({ message: "Desktop key action requires a key." });
      }
      mutationResult =
        keys.length === 1
          ? yield* callDesktopTool(driver, "press_key", {
              pid: windowRef.pid,
              window_id: windowRef.windowId,
              key: keys[0],
            })
          : yield* callDesktopTool(driver, "hotkey", {
              pid: windowRef.pid,
              window_id: windowRef.windowId,
              keys,
            });
    } else {
      return yield* new ComputerUseError({
        message: `Action '${action.action}' is not supported on the desktop surface.`,
      });
    }

    const shouldCapture = "captureAfter" in action ? action.captureAfter === true : false;
    const captured = shouldCapture ? yield* captureWindow(driver, windowRef) : null;
    return {
      surface: "desktop",
      action: action.action,
      summary:
        action.action === "wait"
          ? `Waited ${action.durationMs} ms.`
          : mutationSummary(
              action.action,
              JSON.stringify(windowRef.title ?? windowRef.appName ?? "the active window"),
              mutationResult?.actionOutcome,
            ),
      desktopTarget: toDesktopTarget(windowRef),
      ...(captured?.screenshot ? { screenshot: captured.screenshot } : {}),
      ...(captured?.text ? { treeText: captured.text } : {}),
      ...(mutationResult?.detailsJson ? { detailsJson: mutationResult.detailsJson } : {}),
      ...(mutationResult?.detailsJson ? { actionDetailsJson: mutationResult.detailsJson } : {}),
      ...(captured?.detailsJson ? { captureDetailsJson: captured.detailsJson } : {}),
      ...(mutationResult?.actionOutcome ? { actionOutcome: mutationResult.actionOutcome } : {}),
    } satisfies ComputerUseResult;
  });
