/**
 * Dormant closed desktop v2 action/result contract (plan M3 "Freeze the public
 * v2 wire contract"). Schema-only: no consumer, tool definition or route uses
 * it while legacy Driver 0.9.1 stays selected; the legacy `ComputerUseAction`
 * union and browser actions are unchanged. Raw PID/window selectors are
 * forbidden in v2 (presence fails decoding), references are opaque.
 */
import { Schema } from "effect";

import { TrimmedNonEmptyString } from "../core/baseSchemas";
import {
  COMPUTER_USE_ACCESSIBILITY_MAX_DEPTH,
  COMPUTER_USE_APP_NAME_MAX_CHARS,
  COMPUTER_USE_KEY_MAX_CHARS,
  COMPUTER_USE_TEXT_MAX_CHARS,
  COMPUTER_USE_URL_MAX_CHARS,
  COMPUTER_USE_WAIT_DURATION_MS_MAX,
  ComputerUseExecutionStatus,
} from "./computerUse";

export const COMPUTER_USE_REF_MAX_CHARS = 128;
export const COMPUTER_USE_V2_SCROLL_MAX = 100;
/** Closed structs: unknown keys (e.g. `window_id`, typos) fail decoding. */
const STRICT = { parseOptions: { onExcessProperty: "error" } } as const;

const Ref = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(COMPUTER_USE_REF_MAX_CHARS),
);
/** Zero-based finite pixel coordinate within the referenced frame. */
const Pixel = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const ScrollDelta = Schema.Finite;
const Delivery = Schema.Literals(["foreground", "background"]);
export type ComputerUseDelivery = typeof Delivery.Type;

/** Present raw selectors fail; v2 addresses targets by opaque reference only. */
const forbiddenRawSelectors = {
  pid: Schema.optional(Schema.Never),
  windowId: Schema.optional(Schema.Never),
} as const;
const base = {
  schemaVersion: Schema.Literal(2),
  surface: Schema.Literal("desktop"),
  ...forbiddenRawSelectors,
} as const;
const delivery = {
  delivery: Schema.optional(Delivery),
  /** Compatibility spelling; conflicting with `delivery` is refused. */
  background: Schema.optional(Schema.Boolean),
} as const;
const captureAfter = { captureAfter: Schema.optional(Schema.Boolean) } as const;

export const DesktopV2Capture = Schema.Struct({
  ...base,
  action: Schema.Literal("capture"),
  targetRef: Schema.optional(Ref),
}).annotate(STRICT);
export const DesktopV2GetPageInfo = Schema.Struct({
  ...base,
  action: Schema.Literal("get_page_info"),
  targetRef: Schema.optional(Ref),
}).annotate(STRICT);
export const DesktopV2Click = Schema.Struct({
  ...base,
  ...delivery,
  ...captureAfter,
  action: Schema.Literal("click"),
  observationRef: Ref,
  x: Pixel,
  y: Pixel,
  button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
}).annotate(STRICT);
export const DesktopV2Drag = Schema.Struct({
  ...base,
  ...delivery,
  ...captureAfter,
  action: Schema.Literal("drag"),
  observationRef: Ref,
  startX: Pixel,
  startY: Pixel,
  endX: Pixel,
  endY: Pixel,
}).annotate(STRICT);
export const DesktopV2Scroll = Schema.Struct({
  ...base,
  ...delivery,
  ...captureAfter,
  action: Schema.Literal("scroll"),
  targetRef: Schema.optional(Ref),
  observationRef: Schema.optional(Ref),
  deltaX: Schema.optional(ScrollDelta),
  deltaY: Schema.optional(ScrollDelta),
  x: Schema.optional(Pixel),
  y: Schema.optional(Pixel),
}).annotate(STRICT);
export const DesktopV2Type = Schema.Struct({
  ...base,
  ...delivery,
  ...captureAfter,
  action: Schema.Literal("type"),
  targetRef: Ref,
  text: Schema.String.check(Schema.isMaxLength(COMPUTER_USE_TEXT_MAX_CHARS)),
}).annotate(STRICT);
export const DesktopV2Key = Schema.Struct({
  ...base,
  ...delivery,
  ...captureAfter,
  action: Schema.Literal("key"),
  targetRef: Ref,
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_USE_KEY_MAX_CHARS)),
}).annotate(STRICT);
export const DesktopV2Wait = Schema.Struct({
  ...base,
  ...captureAfter,
  action: Schema.Literal("wait"),
  targetRef: Schema.optional(Ref),
  durationMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(COMPUTER_USE_WAIT_DURATION_MS_MAX),
  ),
}).annotate(STRICT);
const AppName = TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_USE_APP_NAME_MAX_CHARS));
export const DesktopV2LaunchApp = Schema.Struct({
  ...base,
  action: Schema.Literal("launch_app"),
  name: AppName,
  background: Schema.optional(Schema.Boolean),
}).annotate(STRICT);
export const DesktopV2FocusApp = Schema.Struct({
  ...base,
  action: Schema.Literal("focus_app"),
  targetRef: Schema.optional(Ref),
  name: Schema.optional(AppName),
}).annotate(STRICT);
export const DesktopV2Navigate = Schema.Struct({
  ...base,
  ...captureAfter,
  action: Schema.Literal("navigate"),
  url: TrimmedNonEmptyString.check(
    Schema.isMaxLength(COMPUTER_USE_URL_MAX_CHARS),
    Schema.isPattern(/^https?:\/\//i),
  ),
  background: Schema.optional(Schema.Boolean),
}).annotate(STRICT);
export const DesktopV2ListApps = Schema.Struct({
  ...base,
  action: Schema.Literal("list_apps"),
}).annotate(STRICT);
export const DesktopV2ListWindows = Schema.Struct({
  ...base,
  action: Schema.Literal("list_windows"),
}).annotate(STRICT);
export const DesktopV2AccessibilityTree = Schema.Struct({
  ...base,
  action: Schema.Literal("get_accessibility_tree"),
  targetRef: Schema.optional(Ref),
  maxDepth: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(COMPUTER_USE_ACCESSIBILITY_MAX_DEPTH),
    ),
  ),
}).annotate(STRICT);
/** Agent route is metadata-only and never prompts. */
export const DesktopV2CheckPermissions = Schema.Struct({
  ...base,
  action: Schema.Literal("check_permissions"),
  prompt: Schema.optional(Schema.Literal(false)),
}).annotate(STRICT);
export const DesktopV2Doctor = Schema.Struct({
  ...base,
  action: Schema.Literal("doctor"),
}).annotate(STRICT);

export const ComputerUseDesktopV2Action = Schema.Union([
  DesktopV2Capture,
  DesktopV2GetPageInfo,
  DesktopV2Click,
  DesktopV2Drag,
  DesktopV2Scroll,
  DesktopV2Type,
  DesktopV2Key,
  DesktopV2Wait,
  DesktopV2LaunchApp,
  DesktopV2FocusApp,
  DesktopV2Navigate,
  DesktopV2ListApps,
  DesktopV2ListWindows,
  DesktopV2AccessibilityTree,
  DesktopV2CheckPermissions,
  DesktopV2Doctor,
]);
export type ComputerUseDesktopV2Action = typeof ComputerUseDesktopV2Action.Type;

/** Frozen safe error codes; details never carry excluded identities/content. */
export const ComputerUseV2ErrorCodes = [
  "version_required",
  "invalid_arguments",
  "selector_conflict",
  "delivery_conflict",
  "target_missing",
  "target_stale",
  "observation_missing",
  "observation_stale",
  "modality_mismatch",
  "app_disallowed",
  "protected_target",
  "restoration_blocked",
  "foreground_unavailable",
  "background_unavailable",
  "capture_provenance_unproven",
  "paused",
  "checkin_required",
  "policy_pending",
  "authority_conflict",
  "control_unavailable",
  "queue_full",
  "deadline_exceeded",
  "retirement_unknown",
] as const;
export const ComputerUseV2ErrorCode = Schema.Literals(ComputerUseV2ErrorCodes);
export type ComputerUseV2ErrorCode = typeof ComputerUseV2ErrorCode.Type;

export const ComputerUseV2Completion = Schema.Literals(["not_started", "completed", "unknown"]);
export type ComputerUseV2Completion = typeof ComputerUseV2Completion.Type;

export const ComputerUseDesktopV2Result = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  surface: Schema.Literal("desktop"),
  operationId: TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_USE_REF_MAX_CHARS)),
  action: TrimmedNonEmptyString,
  executionStatus: ComputerUseExecutionStatus,
  completion: ComputerUseV2Completion,
  route: Schema.optional(TrimmedNonEmptyString),
  delivery: Schema.optional(Delivery),
  /** Partial delivery keeps counts (e.g. scroll chunks delivered/requested). */
  partial: Schema.optional(
    Schema.Struct({
      delivered: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      requested: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }).annotate(STRICT),
  ),
  refused: Schema.optional(Schema.Boolean),
  errorCode: Schema.optional(ComputerUseV2ErrorCode),
  recoveryHint: Schema.optional(Schema.Literal("observe_again")),
  targetRef: Schema.optional(Ref),
  observationRef: Schema.optional(Ref),
  verified: Schema.optional(Schema.Boolean),
  captureError: Schema.optional(ComputerUseV2ErrorCode),
  summary: TrimmedNonEmptyString,
})
  .check(
    Schema.makeFilter(
      (result) =>
        (result.partial === undefined || result.partial.delivered <= result.partial.requested) &&
        (result.refused !== true || result.completion === "not_started"),
    ),
  )
  .annotate(STRICT);
export type ComputerUseDesktopV2Result = typeof ComputerUseDesktopV2Result.Type;
