import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

/** Encode separators so arbitrary thread IDs cannot overlap another thread's prefix. */
export const textGenerationStatusPrefix = (threadId: ThreadId) =>
  `text-generation-scoped-status:${encodeURIComponent(threadId)}:`;
