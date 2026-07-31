import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId } from "../core/baseSchemas";

export const ServerSetThreadPinnedInput = Schema.Struct({
  threadId: ThreadId,
  pinned: Schema.Boolean,
});
export type ServerSetThreadPinnedInput = typeof ServerSetThreadPinnedInput.Type;

export const ServerSetThreadPinnedResult = Schema.Struct({
  threadId: ThreadId,
  pinned: Schema.Boolean,
  pinnedAt: Schema.NullOr(IsoDateTime),
  count: NonNegativeInt,
  limit: NonNegativeInt,
  remaining: NonNegativeInt,
});
export type ServerSetThreadPinnedResult = typeof ServerSetThreadPinnedResult.Type;
