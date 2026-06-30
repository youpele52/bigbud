import type {
  ComputerUseAction,
  ComputerUseDesktopTarget,
  ComputerUseResult,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type { CuaDriverCallResult, CuaDriverShape } from "../Services/CuaDriver.ts";
import { ComputerUseError } from "../Services/ComputerUse.ts";

interface WindowRef {
  readonly pid?: number | undefined;
  readonly windowId?: number | undefined;
  readonly appName?: string | undefined;
  readonly title?: string | undefined;
  readonly bounds?: { x: number; y: number; width: number; height: number } | undefined;
}

function toDesktopTarget(windowRef: WindowRef | null): ComputerUseDesktopTarget | undefined {
  if (!windowRef) {
    return undefined;
  }
  return {
    ...(windowRef.pid === undefined ? {} : { pid: windowRef.pid }),
    ...(windowRef.windowId === undefined ? {} : { windowId: windowRef.windowId }),
    ...(windowRef.appName ? { appName: windowRef.appName } : {}),
    ...(windowRef.title ? { title: windowRef.title } : {}),
    ...(windowRef.bounds ? { bounds: windowRef.bounds } : {}),
  };
}

function toError(cause: unknown, fallback: string): ComputerUseError {
  if (cause instanceof ComputerUseError) {
    return cause;
  }
  if (cause instanceof Error) {
    return new ComputerUseError({ message: cause.message, cause });
  }
  return new ComputerUseError({ message: fallback, cause });
}

function stringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.stringify(value, null, 2);
}

function firstText(result: CuaDriverCallResult): string | undefined {
  for (const entry of result.content) {
    if (typeof entry.text === "string" && entry.text.length > 0) {
      return entry.text;
    }
  }
  return undefined;
}

function firstImage(result: {
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly data?: string | undefined;
    readonly mimeType?: string | undefined;
  }>;
}): ComputerUseResult["screenshot"] {
  for (const entry of result.content) {
    if (
      entry.type === "image" &&
      typeof entry.data === "string" &&
      typeof entry.mimeType === "string"
    ) {
      return {
        mimeType: entry.mimeType,
        dataBase64: entry.data,
      };
    }
  }
  return undefined;
}

function normalizeWindowEntry(value: unknown): WindowRef | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const bounds =
    record.bounds && typeof record.bounds === "object"
      ? (record.bounds as Record<string, unknown>)
      : null;
  return {
    ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
    ...(typeof record.window_id === "number" ? { windowId: record.window_id } : {}),
    ...(typeof record.app_name === "string" ? { appName: record.app_name } : {}),
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(bounds &&
    typeof bounds.x === "number" &&
    typeof bounds.y === "number" &&
    typeof bounds.width === "number" &&
    typeof bounds.height === "number"
      ? {
          bounds: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
        }
      : {}),
  };
}

function pickFrontmostWindow(structuredContent: unknown): WindowRef | null {
  if (!structuredContent || typeof structuredContent !== "object") {
    return null;
  }
  const windows = (structuredContent as Record<string, unknown>).windows;
  if (!Array.isArray(windows)) {
    return null;
  }
  const normalized = windows
    .map(normalizeWindowEntry)
    .filter((entry): entry is WindowRef => entry !== null && entry.bounds !== undefined);
  normalized.sort((left, right) => (right.windowId ?? 0) - (left.windowId ?? 0));
  return normalized[0] ?? null;
}

function callDesktopTool(
  driver: CuaDriverShape,
  name: string,
  args: Record<string, unknown>,
): Effect.Effect<
  {
    readonly screenshot?: ComputerUseResult["screenshot"];
    readonly text?: string;
    readonly detailsJson?: string;
  },
  ComputerUseError
> {
  return driver.callTool(name, args).pipe(
    Effect.map((result) => {
      const screenshot = firstImage(result);
      const text = firstText(result);
      const detailsJson = stringify(result.structuredContent);
      return {
        ...(screenshot ? { screenshot } : {}),
        ...(text ? { text } : {}),
        ...(detailsJson ? { detailsJson } : {}),
      };
    }),
    Effect.mapError((cause) => toError(cause, `Desktop computer-use tool '${name}' failed.`)),
  );
}

function currentDesktopWindow(driver: CuaDriverShape) {
  return driver.callTool("list_windows", {}).pipe(
    Effect.map((result) => pickFrontmostWindow(result.structuredContent)),
    Effect.mapError((cause) => toError(cause, "Failed to read desktop windows.")),
  );
}

function captureWindow(driver: CuaDriverShape, windowRef: WindowRef) {
  return callDesktopTool(driver, "get_window_state", {
    ...(windowRef.pid === undefined ? {} : { pid: windowRef.pid }),
    ...(windowRef.windowId === undefined ? {} : { window_id: windowRef.windowId }),
    capture_mode: "som",
  });
}

export const executeDesktopComputerUse = (
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
          ...(action.background === undefined ? {} : { background: action.background }),
        });
        return {
          surface: "desktop",
          action: action.action,
          summary: `Launched ${JSON.stringify(action.name)}.`,
          ...(result.detailsJson ? { detailsJson: result.detailsJson } : {}),
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
            summary: `Focused PID ${action.pid}.`,
            ...(result.detailsJson ? { detailsJson: result.detailsJson } : {}),
          } satisfies ComputerUseResult;
        }
        if (action.name) {
          const result = yield* callDesktopTool(driver, "launch_app", { name: action.name });
          return {
            surface: "desktop",
            action: action.action,
            summary: `Focused ${JSON.stringify(action.name)}.`,
            ...(result.detailsJson ? { detailsJson: result.detailsJson } : {}),
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
        const result = yield* callDesktopTool(driver, "get_accessibility_tree", {
          ...(baseWindow.pid === undefined ? {} : { pid: baseWindow.pid }),
          ...(baseWindow.windowId === undefined ? {} : { window_id: baseWindow.windowId }),
          ...(action.maxDepth === undefined ? {} : { max_depth: action.maxDepth }),
        });
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

    if (action.action === "wait") {
      yield* Effect.sleep(`${action.durationMs} millis`);
    } else if (action.action === "click") {
      yield* callDesktopTool(driver, "click", {
        pid: windowRef.pid,
        window_id: windowRef.windowId,
        x: action.x,
        y: action.y,
        button: action.button ?? "left",
      });
    } else if (action.action === "drag") {
      yield* callDesktopTool(driver, "drag", {
        pid: windowRef.pid,
        window_id: windowRef.windowId,
        path: [
          { x: action.startX, y: action.startY },
          { x: action.endX, y: action.endY },
        ],
      });
    } else if (action.action === "scroll") {
      yield* callDesktopTool(driver, "scroll", {
        pid: windowRef.pid,
        window_id: windowRef.windowId,
        ...(action.deltaX === undefined ? {} : { delta_x: action.deltaX }),
        ...(action.deltaY === undefined ? {} : { delta_y: action.deltaY }),
        ...(action.x === undefined ? {} : { x: action.x }),
        ...(action.y === undefined ? {} : { y: action.y }),
      });
    } else if (action.action === "type") {
      yield* callDesktopTool(driver, "type_text", {
        pid: windowRef.pid,
        window_id: windowRef.windowId,
        text: action.text,
      });
    } else if (action.action === "key") {
      yield* callDesktopTool(driver, "press_keys", {
        pid: windowRef.pid,
        window_id: windowRef.windowId,
        keys: action.key
          .split("+")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
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
      summary: `Executed ${action.action} on ${JSON.stringify(windowRef.title ?? windowRef.appName ?? "the active window")}.`,
      desktopTarget: toDesktopTarget(windowRef),
      ...(captured?.screenshot ? { screenshot: captured.screenshot } : {}),
      ...(captured?.text ? { treeText: captured.text } : {}),
      ...(captured?.detailsJson ? { detailsJson: captured.detailsJson } : {}),
    } satisfies ComputerUseResult;
  });
