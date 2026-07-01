import { Schema } from "effect";

import { PositiveInt, TrimmedNonEmptyString } from "../core/baseSchemas";

export const COMPUTER_USE_COORDINATE_MIN = -100_000;
export const COMPUTER_USE_COORDINATE_MAX = 100_000;
export const COMPUTER_USE_SCROLL_DELTA_MIN = -50_000;
export const COMPUTER_USE_SCROLL_DELTA_MAX = 50_000;
export const COMPUTER_USE_TEXT_MAX_CHARS = 10_000;
export const COMPUTER_USE_KEY_MAX_CHARS = 128;
export const COMPUTER_USE_APP_NAME_MAX_CHARS = 256;
export const COMPUTER_USE_URL_MAX_CHARS = 4_096;
export const COMPUTER_USE_WAIT_DURATION_MS_MAX = 15 * 60_000;
export const COMPUTER_USE_ACCESSIBILITY_MAX_DEPTH = 50;

const Coordinate = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(COMPUTER_USE_COORDINATE_MIN),
).check(Schema.isLessThanOrEqualTo(COMPUTER_USE_COORDINATE_MAX));
const ScrollDelta = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(COMPUTER_USE_SCROLL_DELTA_MIN),
).check(Schema.isLessThanOrEqualTo(COMPUTER_USE_SCROLL_DELTA_MAX));
const OptionalCoordinate = Schema.optional(Coordinate);
const Surface = Schema.Literals(["browser", "desktop"]);
export type ComputerUseSurface = typeof Surface.Type;

const MouseButton = Schema.Literals(["left", "middle", "right"]);
export type MouseButton = typeof MouseButton.Type;

const captureAfterField = {
  captureAfter: Schema.optional(Schema.Boolean),
} as const;

const surfaceField = {
  surface: Schema.optional(Surface),
} as const;

export const ComputerUseCaptureAction = Schema.Struct({
  action: Schema.Literal("capture"),
  ...surfaceField,
});
export type ComputerUseCaptureAction = typeof ComputerUseCaptureAction.Type;

export const ComputerUseNavigateAction = Schema.Struct({
  action: Schema.Literal("navigate"),
  url: TrimmedNonEmptyString.check(
    Schema.isMaxLength(COMPUTER_USE_URL_MAX_CHARS),
    Schema.isPattern(/^https?:\/\//i),
  ),
  ...surfaceField,
  ...captureAfterField,
});
export type ComputerUseNavigateAction = typeof ComputerUseNavigateAction.Type;

export const ComputerUseClickAction = Schema.Struct({
  action: Schema.Literal("click"),
  x: Coordinate,
  y: Coordinate,
  button: Schema.optional(MouseButton),
  ...surfaceField,
  ...captureAfterField,
});
export type ComputerUseClickAction = typeof ComputerUseClickAction.Type;

export const ComputerUseDragAction = Schema.Struct({
  action: Schema.Literal("drag"),
  startX: Coordinate,
  startY: Coordinate,
  endX: Coordinate,
  endY: Coordinate,
  ...surfaceField,
  ...captureAfterField,
});
export type ComputerUseDragAction = typeof ComputerUseDragAction.Type;

export const ComputerUseScrollAction = Schema.Struct({
  action: Schema.Literal("scroll"),
  deltaX: Schema.optional(ScrollDelta),
  deltaY: Schema.optional(ScrollDelta),
  x: OptionalCoordinate,
  y: OptionalCoordinate,
  ...surfaceField,
  ...captureAfterField,
});
export type ComputerUseScrollAction = typeof ComputerUseScrollAction.Type;

export const ComputerUseTypeAction = Schema.Struct({
  action: Schema.Literal("type"),
  text: Schema.String.check(Schema.isMaxLength(COMPUTER_USE_TEXT_MAX_CHARS)),
  ...surfaceField,
  ...captureAfterField,
});
export type ComputerUseTypeAction = typeof ComputerUseTypeAction.Type;

export const ComputerUseKeyAction = Schema.Struct({
  action: Schema.Literal("key"),
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_USE_KEY_MAX_CHARS)),
  ...surfaceField,
  ...captureAfterField,
});
export type ComputerUseKeyAction = typeof ComputerUseKeyAction.Type;

export const ComputerUseWaitAction = Schema.Struct({
  action: Schema.Literal("wait"),
  durationMs: PositiveInt.check(Schema.isLessThanOrEqualTo(COMPUTER_USE_WAIT_DURATION_MS_MAX)),
  ...surfaceField,
  ...captureAfterField,
});
export type ComputerUseWaitAction = typeof ComputerUseWaitAction.Type;

export const ComputerUseGetPageInfoAction = Schema.Struct({
  action: Schema.Literal("get_page_info"),
  ...surfaceField,
});
export type ComputerUseGetPageInfoAction = typeof ComputerUseGetPageInfoAction.Type;

export const ComputerUseListWindowsAction = Schema.Struct({
  action: Schema.Literal("list_windows"),
});
export type ComputerUseListWindowsAction = typeof ComputerUseListWindowsAction.Type;

export const ComputerUseListAppsAction = Schema.Struct({
  action: Schema.Literal("list_apps"),
});
export type ComputerUseListAppsAction = typeof ComputerUseListAppsAction.Type;

export const ComputerUseCheckPermissionsAction = Schema.Struct({
  action: Schema.Literal("check_permissions"),
  prompt: Schema.optional(Schema.Boolean),
});
export type ComputerUseCheckPermissionsAction = typeof ComputerUseCheckPermissionsAction.Type;

export const ComputerUseDoctorAction = Schema.Struct({
  action: Schema.Literal("doctor"),
});
export type ComputerUseDoctorAction = typeof ComputerUseDoctorAction.Type;

export const ComputerUseLaunchAppAction = Schema.Struct({
  action: Schema.Literal("launch_app"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_USE_APP_NAME_MAX_CHARS)),
  background: Schema.optional(Schema.Boolean),
});
export type ComputerUseLaunchAppAction = typeof ComputerUseLaunchAppAction.Type;

export const ComputerUseFocusAppAction = Schema.Struct({
  action: Schema.Literal("focus_app"),
  pid: Schema.optional(PositiveInt),
  windowId: Schema.optional(PositiveInt),
  name: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_USE_APP_NAME_MAX_CHARS)),
  ),
});
export type ComputerUseFocusAppAction = typeof ComputerUseFocusAppAction.Type;

export const ComputerUseGetAccessibilityTreeAction = Schema.Struct({
  action: Schema.Literal("get_accessibility_tree"),
  pid: Schema.optional(PositiveInt),
  windowId: Schema.optional(PositiveInt),
  maxDepth: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(COMPUTER_USE_ACCESSIBILITY_MAX_DEPTH)),
  ),
});
export type ComputerUseGetAccessibilityTreeAction =
  typeof ComputerUseGetAccessibilityTreeAction.Type;

export const ComputerUseAction = Schema.Union([
  ComputerUseCaptureAction,
  ComputerUseNavigateAction,
  ComputerUseClickAction,
  ComputerUseDragAction,
  ComputerUseScrollAction,
  ComputerUseTypeAction,
  ComputerUseKeyAction,
  ComputerUseWaitAction,
  ComputerUseGetPageInfoAction,
  ComputerUseListWindowsAction,
  ComputerUseListAppsAction,
  ComputerUseCheckPermissionsAction,
  ComputerUseDoctorAction,
  ComputerUseLaunchAppAction,
  ComputerUseFocusAppAction,
  ComputerUseGetAccessibilityTreeAction,
]);
export type ComputerUseAction = typeof ComputerUseAction.Type;

export const ComputerUsePageInfo = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
});
export type ComputerUsePageInfo = typeof ComputerUsePageInfo.Type;

export const ComputerUseBounds = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  width: Coordinate,
  height: Coordinate,
});
export type ComputerUseBounds = typeof ComputerUseBounds.Type;

export const ComputerUseDesktopTarget = Schema.Struct({
  pid: Schema.optional(PositiveInt),
  windowId: Schema.optional(PositiveInt),
  appName: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  bounds: Schema.optional(ComputerUseBounds),
});
export type ComputerUseDesktopTarget = typeof ComputerUseDesktopTarget.Type;

export const ComputerUseScreenshot = Schema.Struct({
  mimeType: TrimmedNonEmptyString,
  dataBase64: TrimmedNonEmptyString,
  attachmentId: Schema.optional(TrimmedNonEmptyString),
  attachmentUrl: Schema.optional(TrimmedNonEmptyString),
});
export type ComputerUseScreenshot = typeof ComputerUseScreenshot.Type;

export const ComputerUseDiagnostic = Schema.Struct({
  status: Schema.Literals(["ready", "degraded", "unavailable"]),
  message: TrimmedNonEmptyString,
  detailsJson: Schema.optional(Schema.String),
});
export type ComputerUseDiagnostic = typeof ComputerUseDiagnostic.Type;

export const ComputerUseResult = Schema.Struct({
  surface: Surface,
  action: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  page: Schema.optional(ComputerUsePageInfo),
  desktopTarget: Schema.optional(ComputerUseDesktopTarget),
  screenshot: Schema.optional(ComputerUseScreenshot),
  treeText: Schema.optional(Schema.String),
  detailsJson: Schema.optional(Schema.String),
  diagnostics: Schema.optional(ComputerUseDiagnostic),
});
export type ComputerUseResult = typeof ComputerUseResult.Type;
