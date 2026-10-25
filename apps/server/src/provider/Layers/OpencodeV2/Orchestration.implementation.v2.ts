import { V2_THREAD_HANDLER_V1 } from "./Orchestration.implementation.v1.ts";
import type { V2PureThreadHandler } from "./Orchestration.implementation.types.ts";

/** Bundled second generation for conformance: a real preparation/default and final-result change. */
export const V2_THREAD_HANDLER_V2: V2PureThreadHandler = Object.freeze<V2PureThreadHandler>({
  prepare(value) {
    const prepared = V2_THREAD_HANDLER_V1.prepare(value);
    return prepared.action === "list_threads" && prepared.limit === undefined
      ? { ...prepared, limit: 1 }
      : prepared;
  },
  interpret({ canonicalResult }) {
    return { result: canonicalResult, implementation: "bounded-list-v2" };
  },
});
