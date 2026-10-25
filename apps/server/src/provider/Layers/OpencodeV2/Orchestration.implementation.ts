import { V2_THREAD_HANDLER_V1 } from "./Orchestration.implementation.v1.ts";
import { V2_THREAD_HANDLER_V2 } from "./Orchestration.implementation.v2.ts";
import { V2_IMPLEMENTATION_MANIFEST } from "./Orchestration.implementation.manifest.generated.ts";
import type { V2ThreadImplementation } from "./Orchestration.implementation.types.ts";

const implementations = Object.freeze({
  v1: Object.freeze({ ...V2_IMPLEMENTATION_MANIFEST.v1, ...V2_THREAD_HANDLER_V1 }),
  v2: Object.freeze({ ...V2_IMPLEMENTATION_MANIFEST.v2, ...V2_THREAD_HANDLER_V2 }),
});
export type V2ImplementationVersion = keyof typeof implementations;

/** Static release allowlist only: no source checkout, user-selected path or network import at runtime. */
export function v2ThreadImplementation(
  version: V2ImplementationVersion = "v1",
): V2ThreadImplementation {
  if (!Object.hasOwn(implementations, version))
    throw new Error("V2 thread-tool implementation is not release-bundled.");
  const handler = implementations[version];
  if (!handler) throw new Error("V2 thread-tool implementation is not release-bundled.");
  return handler;
}

/** Default selection is for new owners only; references survive retirement until every call physically settles. */
export class V2ThreadImplementationRegistry {
  private selected: V2ImplementationVersion = "v1";
  private readonly entries = new Map<string, { handler: V2ThreadImplementation; refs: number }>();
  constructor(private readonly capacity = 32) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 32)
      throw new Error("V2 immutable generation capacity rejected.");
  }
  select(version: V2ImplementationVersion) {
    v2ThreadImplementation(version);
    this.selected = version;
  }
  current() {
    return v2ThreadImplementation(this.selected);
  }
  acquire(handler = this.current()) {
    if (!Object.values(implementations).some((value) => value === handler))
      throw new Error("V2 unbundled implementation reference rejected.");
    let entry = this.entries.get(handler.implementationDigest);
    if (!entry) {
      if (this.entries.size >= this.capacity)
        throw new Error(
          "V2 thread-tool generation capacity is full; referenced/uncertain generations are not evicted.",
        );
      entry = { handler, refs: 0 };
      this.entries.set(handler.implementationDigest, entry);
    } else if (entry.handler !== handler)
      throw new Error("V2 immutable implementation identity conflict.");
    entry.refs++;
    let released = false;
    return {
      handler: entry.handler,
      release: () => {
        if (released) return;
        released = true;
        entry!.refs--;
        if (!entry!.refs && this.entries.get(handler.implementationDigest) === entry)
          this.entries.delete(handler.implementationDigest);
      },
    };
  }
}
