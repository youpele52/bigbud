import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString, TurnId } from "../core/baseSchemas";
import { BrowserAction, BrowserResult } from "./browser";

export const VisibleBrowserRendererId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type VisibleBrowserRendererId = typeof VisibleBrowserRendererId.Type;

export const VisibleBrowserCommandId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type VisibleBrowserCommandId = typeof VisibleBrowserCommandId.Type;

export const VisibleBrowserLeaseId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type VisibleBrowserLeaseId = typeof VisibleBrowserLeaseId.Type;

export const VisibleBrowserTabId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type VisibleBrowserTabId = typeof VisibleBrowserTabId.Type;

export const VisibleBrowserCommand = Schema.Struct({
  commandId: VisibleBrowserCommandId,
  leaseId: VisibleBrowserLeaseId,
  rendererId: VisibleBrowserRendererId,
  threadId: ThreadId,
  turnId: TurnId,
  action: BrowserAction,
});
export type VisibleBrowserCommand = typeof VisibleBrowserCommand.Type;

export const VisibleBrowserCommandResult = Schema.Struct({
  commandId: VisibleBrowserCommandId,
  rendererId: VisibleBrowserRendererId,
  result: Schema.optional(BrowserResult),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type VisibleBrowserCommandResult = typeof VisibleBrowserCommandResult.Type;

export const VisibleBrowserCommandStreamInput = Schema.Struct({
  rendererId: VisibleBrowserRendererId,
});
export type VisibleBrowserCommandStreamInput = typeof VisibleBrowserCommandStreamInput.Type;

export const VisibleBrowserLeaseRevokeInput = Schema.Struct({
  leaseId: VisibleBrowserLeaseId,
  rendererId: VisibleBrowserRendererId,
  tabId: VisibleBrowserTabId,
});
export type VisibleBrowserLeaseRevokeInput = typeof VisibleBrowserLeaseRevokeInput.Type;

export const VisibleBrowserLeaseSnapshot = Schema.Struct({
  leaseId: VisibleBrowserLeaseId,
  tabId: VisibleBrowserTabId,
  threadId: ThreadId,
  turnId: TurnId,
});
export type VisibleBrowserLeaseSnapshot = typeof VisibleBrowserLeaseSnapshot.Type;
