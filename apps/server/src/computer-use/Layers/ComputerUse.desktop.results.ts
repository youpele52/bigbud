import type {
  ComputerUseActionOutcome,
  ComputerUseDeliveryPath,
  ComputerUseDesktopTarget,
  ComputerUseResult,
} from "@bigbud/contracts";
import { ComputerUseDeliveryPaths } from "@bigbud/contracts";
import { Effect } from "effect";

import type { CuaDriverCallResult, CuaDriverShape } from "../Services/CuaDriver.ts";
import { ComputerUseError } from "../Services/ComputerUse.ts";

interface WindowRef {
  readonly pid?: number | undefined;
  readonly windowId?: number | undefined;
  readonly appName?: string | undefined;
  readonly title?: string | undefined;
  readonly bounds?: { x: number; y: number; width: number; height: number } | undefined;
  readonly zIndex?: number | undefined;
  readonly isOnScreen?: boolean | undefined;
  readonly onCurrentSpace?: boolean | undefined;
}

export interface DesktopToolResult {
  readonly screenshot?: ComputerUseResult["screenshot"];
  readonly text?: string;
  readonly detailsJson?: string;
  readonly actionOutcome?: ComputerUseActionOutcome;
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

export function toError(cause: unknown, fallback: string): ComputerUseError {
  if (cause instanceof ComputerUseError) return cause;
  if (cause instanceof Error) return new ComputerUseError({ message: cause.message, cause });
  return new ComputerUseError({ message: fallback, cause });
}

export function stringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value, null, 2);
  return text.length <= 64 * 1024 ? text : `${text.slice(0, 64 * 1024)}\n…[truncated]`;
}

export function firstText(result: CuaDriverCallResult): string | undefined {
  return result.content.find((entry) => typeof entry.text === "string" && entry.text.length > 0)
    ?.text;
}

function actionOutcome(value: unknown): ComputerUseActionOutcome | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const escalation =
    record.escalation && typeof record.escalation === "object"
      ? (record.escalation as Record<string, unknown>)
      : null;
  const outcome = {
    ...(typeof record.verified === "boolean" ? { verified: record.verified } : {}),
    ...(record.effect === "confirmed" ||
    record.effect === "unverifiable" ||
    record.effect === "suspected_noop"
      ? { effect: record.effect }
      : {}),
    ...(ComputerUseDeliveryPaths.includes(record.path as ComputerUseDeliveryPath)
      ? { path: record.path as ComputerUseDeliveryPath }
      : {}),
    ...((escalation?.recommended === "px" ||
      escalation?.recommended === "foreground" ||
      escalation?.recommended === "page") &&
    typeof escalation.reason === "string" &&
    escalation.reason.length > 0
      ? {
          escalation: {
            recommended: escalation.recommended,
            reason: escalation.reason,
          },
        }
      : {}),
  } satisfies ComputerUseActionOutcome;
  return Object.keys(outcome).length > 0 ? outcome : undefined;
}

export function mutationSummary(
  action: string,
  target: string,
  outcome: ComputerUseActionOutcome | undefined,
): string {
  if (outcome?.effect === "confirmed" || outcome?.verified === true) {
    return `Completed and verified ${action} on ${target}.`;
  }
  if (outcome?.effect === "suspected_noop") {
    return `Sent ${action} to ${target}, but it may not have taken effect; do not assume it succeeded.`;
  }
  if (outcome?.effect === "unverifiable") {
    return `Sent ${action} to ${target}, but the result could not be verified; capture state before continuing.`;
  }
  return `Sent ${action} to ${target}; the driver did not provide a verification outcome.`;
}

function firstImage(result: CuaDriverCallResult): ComputerUseResult["screenshot"] {
  const entry = result.content.find(
    (candidate) =>
      candidate.type === "image" &&
      typeof candidate.data === "string" &&
      typeof candidate.mimeType === "string",
  );
  return entry?.data && entry.mimeType
    ? { mimeType: entry.mimeType, dataBase64: entry.data }
    : undefined;
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

function pickFrontmostWindow(structuredContent: unknown): WindowRef | null {
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

export function callDesktopTool(
  driver: CuaDriverShape,
  name: string,
  args: Record<string, unknown>,
): Effect.Effect<DesktopToolResult, ComputerUseError> {
  return driver.callTool(name, args).pipe(
    Effect.map((result) => {
      const screenshot = firstImage(result);
      const text = firstText(result);
      const detailsJson = stringify(result.structuredContent);
      const outcome = actionOutcome(result.structuredContent);
      return {
        ...(screenshot ? { screenshot } : {}),
        ...(text ? { text } : {}),
        ...(detailsJson ? { detailsJson } : {}),
        ...(outcome ? { actionOutcome: outcome } : {}),
      };
    }),
    Effect.mapError((cause) => toError(cause, `Desktop computer-use tool '${name}' failed.`)),
  );
}

export function currentDesktopWindow(driver: CuaDriverShape) {
  return driver.callTool("list_windows", {}).pipe(
    Effect.map((result) => pickFrontmostWindow(result.structuredContent)),
    Effect.mapError((cause) => toError(cause, "Failed to read desktop windows.")),
  );
}

export function captureWindow(driver: CuaDriverShape, windowRef: WindowRef) {
  return callDesktopTool(driver, "get_window_state", {
    ...(windowRef.pid === undefined ? {} : { pid: windowRef.pid }),
    ...(windowRef.windowId === undefined ? {} : { window_id: windowRef.windowId }),
  });
}
