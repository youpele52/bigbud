import { Schema } from "effect";

import { PositiveInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import {
  COMPUTER_USE_COORDINATE_MAX,
  COMPUTER_USE_COORDINATE_MIN,
  COMPUTER_USE_KEY_MAX_CHARS,
  COMPUTER_USE_SCROLL_DELTA_MAX,
  COMPUTER_USE_SCROLL_DELTA_MIN,
  COMPUTER_USE_TEXT_MAX_CHARS,
  COMPUTER_USE_URL_MAX_CHARS,
  COMPUTER_USE_WAIT_DURATION_MS_MAX,
} from "./computerUse";

export const BROWSER_PAGE_TEXT_MAX_CHARS = 40_000;
export const BrowserTarget = Schema.Literals(["auto", "visible", "background"]);
export type BrowserTarget = typeof BrowserTarget.Type;

export const BrowserExecutionTarget = Schema.Literals(["visible", "background"]);
export type BrowserExecutionTarget = typeof BrowserExecutionTarget.Type;

const browserTargetFields = {
  target: Schema.optional(BrowserTarget),
  tabId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
} as const;

const Coordinate = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(COMPUTER_USE_COORDINATE_MIN),
).check(Schema.isLessThanOrEqualTo(COMPUTER_USE_COORDINATE_MAX));
const ScrollDelta = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(COMPUTER_USE_SCROLL_DELTA_MIN),
).check(Schema.isLessThanOrEqualTo(COMPUTER_USE_SCROLL_DELTA_MAX));
const BrowserMouseButton = Schema.Literals(["left", "middle", "right"]);

const captureAfterField = {
  captureAfter: Schema.optional(Schema.Boolean),
} as const;

export const BrowserCaptureAction = Schema.Struct({
  action: Schema.Literal("capture"),
  ...browserTargetFields,
});
export const BrowserNavigateAction = Schema.Struct({
  action: Schema.Literal("navigate"),
  url: TrimmedNonEmptyString.check(
    Schema.isMaxLength(COMPUTER_USE_URL_MAX_CHARS),
    Schema.isPattern(/^https?:\/\//i),
  ),
  ...captureAfterField,
  ...browserTargetFields,
});
export const BrowserClickAction = Schema.Struct({
  action: Schema.Literal("click"),
  x: Coordinate,
  y: Coordinate,
  button: Schema.optional(BrowserMouseButton),
  ...captureAfterField,
  ...browserTargetFields,
});
export const BrowserDragAction = Schema.Struct({
  action: Schema.Literal("drag"),
  startX: Coordinate,
  startY: Coordinate,
  endX: Coordinate,
  endY: Coordinate,
  ...captureAfterField,
  ...browserTargetFields,
});
export const BrowserScrollAction = Schema.Struct({
  action: Schema.Literal("scroll"),
  deltaX: Schema.optional(ScrollDelta),
  deltaY: Schema.optional(ScrollDelta),
  x: Schema.optional(Coordinate),
  y: Schema.optional(Coordinate),
  ...captureAfterField,
  ...browserTargetFields,
});
export const BrowserTypeAction = Schema.Struct({
  action: Schema.Literal("type"),
  text: Schema.String.check(Schema.isMaxLength(COMPUTER_USE_TEXT_MAX_CHARS)),
  ...captureAfterField,
  ...browserTargetFields,
});
export const BrowserKeyAction = Schema.Struct({
  action: Schema.Literal("key"),
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_USE_KEY_MAX_CHARS)),
  ...captureAfterField,
  ...browserTargetFields,
});
export const BrowserWaitAction = Schema.Struct({
  action: Schema.Literal("wait"),
  durationMs: PositiveInt.check(Schema.isLessThanOrEqualTo(COMPUTER_USE_WAIT_DURATION_MS_MAX)),
  ...captureAfterField,
  ...browserTargetFields,
});
export const BrowserGetPageInfoAction = Schema.Struct({
  action: Schema.Literal("get_page_info"),
  ...browserTargetFields,
});
export const BrowserGetPageTextAction = Schema.Struct({
  action: Schema.Literal("get_page_text"),
  ...browserTargetFields,
});
export const BrowserGoBackAction = Schema.Struct({
  action: Schema.Literal("go_back"),
  ...captureAfterField,
  ...browserTargetFields,
});
export const BrowserGoForwardAction = Schema.Struct({
  action: Schema.Literal("go_forward"),
  ...captureAfterField,
  ...browserTargetFields,
});
export const BrowserReloadAction = Schema.Struct({
  action: Schema.Literal("reload"),
  ...captureAfterField,
  ...browserTargetFields,
});
export const BrowserReleaseTabAction = Schema.Struct({
  action: Schema.Literal("release_tab"),
  ...browserTargetFields,
});
export const BrowserCloseTabAction = Schema.Struct({
  action: Schema.Literal("close_tab"),
  target: Schema.optional(BrowserTarget),
  tabId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});

export const BrowserAction = Schema.Union([
  BrowserCaptureAction,
  BrowserNavigateAction,
  BrowserClickAction,
  BrowserDragAction,
  BrowserScrollAction,
  BrowserTypeAction,
  BrowserKeyAction,
  BrowserWaitAction,
  BrowserGetPageInfoAction,
  BrowserGetPageTextAction,
  BrowserGoBackAction,
  BrowserGoForwardAction,
  BrowserReloadAction,
  BrowserReleaseTabAction,
  BrowserCloseTabAction,
]);
export type BrowserAction = typeof BrowserAction.Type;

export const BrowserPageInfo = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
});
export type BrowserPageInfo = typeof BrowserPageInfo.Type;

export const BrowserScreenshot = Schema.Struct({
  mimeType: TrimmedNonEmptyString,
  dataBase64: TrimmedNonEmptyString,
});
export type BrowserScreenshot = typeof BrowserScreenshot.Type;

export const BrowserTabLimitTab = Schema.Struct({
  tabId: TrimmedNonEmptyString,
  title: Schema.String,
  url: Schema.String,
  openedByAgent: Schema.Boolean,
});
export type BrowserTabLimitTab = typeof BrowserTabLimitTab.Type;

export const BrowserTabLimit = Schema.Struct({
  limit: PositiveInt,
  tabs: Schema.Array(BrowserTabLimitTab),
});
export type BrowserTabLimit = typeof BrowserTabLimit.Type;

export const BrowserResult = Schema.Struct({
  action: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  page: Schema.optional(BrowserPageInfo),
  screenshot: Schema.optional(BrowserScreenshot),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(BROWSER_PAGE_TEXT_MAX_CHARS))),
  target: Schema.optional(BrowserExecutionTarget),
  tabId: Schema.optional(TrimmedNonEmptyString),
  leaseId: Schema.optional(TrimmedNonEmptyString),
  selectionReason: Schema.optional(TrimmedNonEmptyString),
  tabLimit: Schema.optional(BrowserTabLimit),
});
export type BrowserResult = typeof BrowserResult.Type;
