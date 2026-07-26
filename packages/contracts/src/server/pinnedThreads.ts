import { Schema } from "effect";

import { ThreadId } from "../core/baseSchemas";

export const ServerSetThreadPinnedInput = Schema.Struct({
  threadId: ThreadId,
  pinned: Schema.Boolean,
});
export type ServerSetThreadPinnedInput = typeof ServerSetThreadPinnedInput.Type;
