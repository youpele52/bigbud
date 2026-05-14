import { Schema } from "effect";

import { EventId, IsoDateTime, NonNegativeInt, ThreadId, TurnId } from "../core/baseSchemas";
import { ProviderKind } from "./orchestration.provider";

export const ThinkingActivityStreamKind = Schema.Literals([
  "reasoning_text",
  "reasoning_summary_text",
]);
export type ThinkingActivityStreamKind = typeof ThinkingActivityStreamKind.Type;

export const ThinkingActivityPayload = Schema.Struct({
  detail: Schema.String,
  streamKind: ThinkingActivityStreamKind,
  fullCharCount: NonNegativeInt,
  persistedCharCount: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ThinkingActivityPayload = typeof ThinkingActivityPayload.Type;

export const ThinkingActivityDeltaEvent = Schema.Struct({
  type: Schema.Literal("delta"),
  threadId: ThreadId,
  activityId: EventId,
  turnId: Schema.NullOr(TurnId),
  provider: ProviderKind,
  streamKind: ThinkingActivityStreamKind,
  delta: Schema.String,
  createdAt: IsoDateTime,
});
export type ThinkingActivityDeltaEvent = typeof ThinkingActivityDeltaEvent.Type;
