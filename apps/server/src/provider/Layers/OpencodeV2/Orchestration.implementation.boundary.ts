import * as Schema from "effect/Schema";
import { ThreadToolRequest } from "../../../ws/http.threadTools.schema.ts";
import type {
  V2CanonicalBody,
  V2PureAction,
  V2PureJson,
} from "./Orchestration.implementation.types.ts";

/** Own/freeze plain JSON before pure code runs; reject accessors, prototypes and unbounded structures. */
export function v2ImmutableJson(value: unknown): V2PureJson {
  let nodes = 0;
  function copy(item: unknown, depth: number): V2PureJson {
    if (++nodes > 32768 || depth > 64)
      throw new Error("V2 implementation JSON exceeds structural bounds.");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object")
      throw new Error("V2 implementation input is not plain JSON.");
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        item.length > 32768 ||
        Reflect.ownKeys(item).length !== item.length + 1
      )
        throw new Error("V2 implementation array is not bounded dense plain JSON.");
      const array: V2PureJson[] = [];
      for (let index = 0; index < item.length; index++) {
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        if (!property || !("value" in property))
          throw new Error("V2 implementation JSON accessor rejected.");
        array.push(copy(property.value, depth + 1));
      }
      return Object.freeze(array);
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new Error("V2 implementation object prototype rejected.");
    const result: Record<string, V2PureJson> = {};
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== "string") throw new Error("V2 implementation JSON symbol key rejected.");
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !("value" in property))
        throw new Error("V2 implementation JSON accessor rejected.");
      if (!property.enumerable) throw new Error("V2 implementation JSON hidden property rejected.");
      Object.defineProperty(result, key, {
        value: copy(property.value, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(result);
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 131072)
    throw new Error("V2 implementation JSON exceeds byte bound.");
  return result;
}

/** Public action mapping/identity stays version-independent; implementations cannot mint new action authority. */
export function v2CanonicalThreadAction(action: V2PureAction) {
  return action === "get_thread_status"
    ? "get_status"
    : action === "rename_thread"
      ? "rename"
      : action;
}

const v2DefinedFields = (value: object) =>
  Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right));

/** Live strict compatibility boundary never silently drops/coerces fields or grants another action. */
export function validateV2PreparedBody(
  action: V2PureAction,
  body: V2CanonicalBody,
  callerThreadId: string,
): V2CanonicalBody {
  const allowed: Readonly<Record<V2PureAction, readonly string[]>> = {
    create_thread: ["action", "title", "task", "projectId", "watchForCompletion"],
    send_thread_message: ["action", "threadId", "message", "delivery"],
    get_thread_status: ["action", "threadId"],
    list_threads: ["action", "projectId", "status", "limit", "includeExcerpt"],
    rename_thread: ["action", "threadId", "targetThreadId", "title"],
  };
  if (
    Object.keys(body).some((key) => !allowed[action].includes(key)) ||
    (action === "rename_thread" && body.threadId !== callerThreadId)
  )
    throw new Error(
      "V2 pinned body attempted authority/ID fields outside the narrow canonical action boundary.",
    );
  const plain = v2ImmutableJson(body);
  const decoded = Schema.decodeUnknownSync(ThreadToolRequest)(plain, { onExcessProperty: "error" });
  if (
    decoded.action !== v2CanonicalThreadAction(action) ||
    JSON.stringify(v2DefinedFields(decoded)) !== JSON.stringify(v2DefinedFields(plain as object))
  )
    throw new Error(
      "V2 pinned request is incompatible with the current canonical API; no reinterpretation.",
    );
  return plain as unknown as V2CanonicalBody;
}

export function encodeV2FinalResult(value: V2PureJson) {
  const content = JSON.stringify(v2ImmutableJson(value));
  if (Buffer.byteLength(content) > 90000)
    throw new Error(
      "V2 final interpreted callback result exceeds bound; dispatch remains uncertain.",
    );
  return { content };
}
