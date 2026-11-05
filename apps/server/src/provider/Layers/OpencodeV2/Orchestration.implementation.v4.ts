import { V2_THREAD_HANDLER_V3 } from "./Orchestration.implementation.v3.ts";
import type { V2PureThreadHandler } from "./Orchestration.implementation.types.v3.ts";

/** ABI-4 conformance generation; not the production default. Mirrors the retained bounded-list probe. */
export const V2_THREAD_HANDLER_V4: V2PureThreadHandler = Object.freeze<V2PureThreadHandler>({
  prepare(value) {
    const prepared = V2_THREAD_HANDLER_V3.prepare(value);
    return prepared.action === "list_threads" && prepared.limit === undefined
      ? { ...prepared, limit: 1 }
      : prepared;
  },
  interpret({ canonicalResult }) {
    return { result: canonicalResult, implementation: "bounded-list-v4" };
  },
});
