import type {
  V2CanonicalBody,
  V2PureAction,
  V2PureThreadHandler,
} from "./Orchestration.implementation.types.ts";

/** Frozen ABI-1 argument semantics. No executable imports or external/mutable dependencies. */
export const V2_THREAD_HANDLER_V1: V2PureThreadHandler = Object.freeze<V2PureThreadHandler>({
  prepare({ action, input, callerThreadId }) {
    const keys: Readonly<Record<V2PureAction, readonly string[]>> = {
      create_thread: ["title", "task", "projectId", "watchForCompletion"],
      send_thread_message: ["threadId", "message", "delivery"],
      get_thread_status: ["threadId"],
      list_threads: ["projectId", "status", "limit", "includeExcerpt"],
      rename_thread: ["title", "targetThreadId"],
    };
    const required: Readonly<Record<V2PureAction, readonly string[]>> = {
      create_thread: ["title", "task"],
      send_thread_message: ["threadId", "message"],
      get_thread_status: ["threadId"],
      list_threads: [],
      rename_thread: ["title"],
    };
    if (
      !keys[action] ||
      Object.keys(input).some((key) => !keys[action].includes(key)) ||
      required[action].some((key) => !Object.hasOwn(input, key))
    )
      throw new Error("V2 frozen canonical public arguments rejected.");
    for (const [key, value] of Object.entries(input)) {
      if (key === "limit") {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 200)
          throw new Error("V2 frozen limit rejected.");
      } else if (key === "includeExcerpt" || key === "watchForCompletion") {
        if (typeof value !== "boolean") throw new Error("V2 frozen boolean rejected.");
      } else if (typeof value !== "string") throw new Error("V2 frozen string rejected.");
    }
    if (input.delivery !== undefined && input.delivery !== "auto" && input.delivery !== "queue")
      throw new Error("V2 frozen delivery rejected.");
    if (input.status !== undefined && !["active", "archived", "all"].includes(String(input.status)))
      throw new Error("V2 frozen status rejected.");
    return {
      ...input,
      ...(action === "rename_thread" ? { threadId: callerThreadId } : {}),
      action:
        action === "get_thread_status"
          ? "get_status"
          : action === "rename_thread"
            ? "rename"
            : action,
    } as V2CanonicalBody;
  },
  interpret({ canonicalResult }) {
    return canonicalResult;
  },
});
