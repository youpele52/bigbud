import { V2_THREAD_HANDLER_V3 } from "./Orchestration.implementation.v3.ts";
import type { V2PureThreadHandler } from "./Orchestration.implementation.types.v5.ts";

/** New summary interpretation. Retained v1–v4 closures remain byte-for-byte unchanged. */
export const V2_THREAD_HANDLER_V5: V2PureThreadHandler = Object.freeze<V2PureThreadHandler>({
  prepare(value) {
    if (value.action !== "set_elevator_summary")
      return V2_THREAD_HANDLER_V3.prepare({ ...value, action: value.action });
    const { summary } = value.input;
    if (
      Object.keys(value.input).some((key) => key !== "summary") ||
      typeof summary !== "string" ||
      !summary.trim()
    )
      throw new Error("V2 own-thread summary arguments rejected.");
    return { action: "set_elevator_summary", threadId: value.callerThreadId, summary };
  },
  interpret({ canonicalResult }) {
    return canonicalResult;
  },
});
