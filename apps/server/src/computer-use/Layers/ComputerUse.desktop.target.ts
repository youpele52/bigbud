import type { ComputerUseDesktopTarget } from "@bigbud/contracts";
import { Effect } from "effect";
import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import { toError } from "./ComputerUse.desktop.results.ts";

export interface WindowRef {
  readonly pid?: number | undefined;
  readonly windowId?: number | undefined;
  readonly appName?: string | undefined;
  readonly title?: string | undefined;
  readonly bounds?: { x: number; y: number; width: number; height: number } | undefined;
  readonly zIndex?: number | undefined;
  readonly isOnScreen?: boolean | undefined;
  readonly onCurrentSpace?: boolean | undefined;
}

export function toDesktopTarget(windowRef: WindowRef | null): ComputerUseDesktopTarget | undefined {
  if (!windowRef) return undefined;
  return {
    ...(windowRef.pid === undefined ? {} : { pid: windowRef.pid }),
    ...(windowRef.windowId === undefined ? {} : { windowId: windowRef.windowId }),
    ...(windowRef.appName ? { appName: windowRef.appName } : {}),
    ...(windowRef.title ? { title: windowRef.title } : {}),
    ...(windowRef.bounds ? { bounds: windowRef.bounds } : {}),
  };
}

function normalizeWindowEntry(value: unknown): WindowRef | null {
  if (!value || typeof value !== "object") return null;
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
    ...(typeof record.z_index === "number" ? { zIndex: record.z_index } : {}),
    ...(typeof record.is_on_screen === "boolean" ? { isOnScreen: record.is_on_screen } : {}),
    ...(typeof record.on_current_space === "boolean"
      ? { onCurrentSpace: record.on_current_space }
      : {}),
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

/**
 * The frontmost candidate by `z_index`. Refuses (null) when the choice is
 * ambiguous: a z-order tie, or several candidates while the top one has no
 * stacking information (0.38 reports `z_index: null` when it cannot observe
 * stacking and forbids inferring order from array position).
 */
export function pickFrontmostWindow(structuredContent: unknown): WindowRef | null {
  if (!structuredContent || typeof structuredContent !== "object") return null;
  const windows = (structuredContent as Record<string, unknown>).windows;
  if (!Array.isArray(windows)) return null;
  const normalized = windows
    .map(normalizeWindowEntry)
    .filter(
      (entry): entry is WindowRef =>
        entry !== null &&
        entry.bounds !== undefined &&
        entry.pid !== undefined &&
        entry.pid > 0 &&
        entry.windowId !== undefined &&
        entry.windowId > 0 &&
        entry.isOnScreen !== false &&
        entry.onCurrentSpace !== false,
    );
  normalized.sort(
    (left, right) =>
      (right.zIndex ?? Number.NEGATIVE_INFINITY) - (left.zIndex ?? Number.NEGATIVE_INFINITY),
  );
  if (normalized.length > 1 && normalized[0]?.zIndex === undefined) return null;
  if (
    normalized.length > 1 &&
    normalized[0]?.zIndex !== undefined &&
    normalized[0].zIndex === normalized[1]?.zIndex
  ) {
    return null;
  }
  return normalized[0] ?? null;
}

export function findRunningDesktopApp(driver: CuaDriverShape, requestedName: string) {
  return driver.callTool("list_apps", {}).pipe(
    Effect.map((result) => {
      if (!result.structuredContent || typeof result.structuredContent !== "object") return null;
      const apps = (result.structuredContent as Record<string, unknown>).apps;
      if (!Array.isArray(apps)) return null;
      const normalizedName = requestedName.trim().toLowerCase();
      const matches = apps.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        const name =
          typeof record.name === "string"
            ? record.name
            : typeof record.app_name === "string"
              ? record.app_name
              : null;
        return name?.trim().toLowerCase() === normalizedName &&
          record.running === true &&
          typeof record.pid === "number" &&
          record.pid > 0
          ? [{ pid: record.pid }]
          : [];
      });
      return matches.length === 1 ? matches[0] : null;
    }),
    Effect.mapError((cause) => toError(cause, "Failed to resolve the requested desktop app.")),
  );
}

export function currentDesktopWindow(driver: CuaDriverShape) {
  return driver.callTool("list_windows", {}).pipe(
    Effect.map((result) => pickFrontmostWindow(result.structuredContent)),
    Effect.mapError((cause) => toError(cause, "Failed to read desktop windows.")),
  );
}
