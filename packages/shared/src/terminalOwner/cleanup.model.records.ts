import type { CleanupRef } from "@bigbud/contracts/terminal-owner/auth";
import type { RootOp } from "@bigbud/contracts/terminal-owner/identity";
import { canonicalDomain, encodeCanonical } from "./canonical";
import { sha256 } from "./auth";
import { requireContract } from "./errors";

export interface CleanupResource {
  identity: Uint8Array;
  disposition: "pending" | "live" | "uncertain" | "clean";
  started: boolean;
  generation: string;
}
export interface CleanupParent {
  op: RootOp;
  shutdownId: Uint8Array;
  digest: string;
  cut: Uint8Array;
}
export interface CleanupAttempt {
  launched: boolean;
  stopped: boolean;
  expiresAt: number;
  capsule?: Uint8Array;
  issuer?: Uint8Array;
}
interface Child {
  ref: CleanupRef;
  id: string;
  digest?: string;
  state: "reserved" | "accepted" | "succeeded" | "cleanupUnknown";
  effects: number;
}
export const cleanupHex = (value: Uint8Array) => Buffer.from(value).toString("hex");
export function cleanupU32(value: number) {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value);
  return result;
}

/** Parent-fixed, non-evictable child identities and semantic effect fences. */
export class CleanupChildRecordsModel {
  private records = new Map<string, Child>();
  constructor(private readonly epoch: Uint8Array) {}
  reserve(kind: 1 | 2 | 3, slot: number, identity: Uint8Array, parent: CleanupParent) {
    const ref: CleanupRef = {
      parentRootSequence: parent.op.sequence,
      shutdownId: parent.shutdownId.slice(),
      class: kind,
      slot,
      resourceIdentity: identity.slice(),
    };
    const id = cleanupHex(
      sha256(
        canonicalDomain("cleanup-child/v1"),
        this.epoch,
        parent.shutdownId,
        Uint8Array.of(kind),
        cleanupU32(slot),
        identity,
      ),
    );
    requireContract(!this.records.has(`${kind}:${slot}`), "IDENTITY_CONFLICT");
    this.records.set(`${kind}:${slot}`, { ref, id, state: "reserved", effects: 0 });
  }
  query(kind: 1 | 2 | 3, slot: number) {
    const child = this.records.get(`${kind}:${slot}`);
    requireContract(child, "CHILD_UNKNOWN");
    return structuredClone(child);
  }
  accept(kind: 1 | 2 | 3, slot: number, operation: number, payload: Uint8Array, proven: boolean) {
    const child = this.records.get(`${kind}:${slot}`);
    requireContract(child, "CHILD_UNKNOWN");
    requireContract(
      payload.length <= 4096 &&
        Number.isInteger(operation) &&
        operation >= 0 &&
        operation <= 4294967295,
      "CAPACITY",
    );
    const digest = cleanupHex(
      sha256(
        canonicalDomain("cleanup-mutation/v1"),
        this.epoch,
        encodeCanonical("CleanupRef", child.ref),
        cleanupU32(operation),
        payload,
      ),
    );
    if (child.digest) {
      requireContract(child.digest === digest, "DIGEST_CONFLICT");
      return false;
    }
    requireContract(proven, "PRECONDITION_FAILED");
    requireContract(
      operation === 39
        ? kind === 1
        : operation === 22
          ? kind === 3 && slot === 7
          : operation === 28
            ? kind === 3 && slot === 6
            : operation === 31
              ? kind === 3 && [10, 13].includes(slot)
              : operation === 40
                ? kind === 3 && [9, 12].includes(slot)
                : operation === 0,
      "CHILD_KIND",
    );
    child.digest = digest;
    child.effects = 1;
    child.state = "accepted";
    return true;
  }
  disposition(kind: 1 | 2 | 3, slot: number, clean: boolean) {
    const child = this.records.get(`${kind}:${slot}`);
    requireContract(child?.digest, "CHILD_UNKNOWN");
    requireContract(child.state !== "succeeded" || clean, "DISPOSITION_REGRESSION");
    const state = clean ? "succeeded" : "cleanupUnknown";
    if (child.state === state) return false;
    child.state = state;
    return true;
  }
  observe() {
    const child = this.records.get("3:8");
    requireContract(child, "PARENT_UNKNOWN");
    child.state = "succeeded";
  }
  settledExcept(exceptions: readonly string[]) {
    return [...this.records.entries()].every(
      ([key, c]) => exceptions.includes(key) || c.state === "succeeded",
    );
  }
  snapshot() {
    return [...this.records.values()].map((c) => structuredClone(c));
  }
  get size() {
    return this.records.size;
  }
}
