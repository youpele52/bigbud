import { isDeepStrictEqual } from "node:util";
import { encodeCanonical } from "./canonical";
import type { OwnerCleanupModel } from "./cleanup.model";
import { id } from "./test.fixture";

type Child = ReturnType<OwnerCleanupModel["snapshot"]>["children"][number];

/** Reuse a pure encoding result only for an identical, independently retained snapshot. */
export function cleanupOutcomeSizer() {
  const checked = new Map<string, { child: Child; bytes: number }>();
  return (child: Child): number => {
    const key = `${child.ref.class}:${child.ref.slot}`;
    const previous = checked.get(key);
    if (previous && isDeepStrictEqual(previous.child, child)) return previous.bytes;
    const state = { reserved: 1, accepted: 2, succeeded: 4, cleanupUnknown: 7 }[child.state];
    const encoded = encodeCanonical("CleanupOutcome", {
      child: child.ref,
      childId: Uint8Array.from(Buffer.from(child.id, "hex")),
      mutationDigest: child.digest ? Uint8Array.from(Buffer.from(child.digest, "hex")) : id(0),
      state,
      dispositionDigest: id(0),
      resultCapsuleDigest: id(0),
      authorityRevision: "248",
    });
    // Never retain the caller's mutable snapshot: edits must invalidate even the first entry.
    checked.set(key, { child: structuredClone(child), bytes: encoded.length });
    return encoded.length;
  };
}
