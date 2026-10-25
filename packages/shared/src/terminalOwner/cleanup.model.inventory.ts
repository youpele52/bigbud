import type { RootOp } from "@bigbud/contracts/terminal-owner/identity";
import type { OwnerShutdownInventory } from "@bigbud/contracts/terminal-owner/shutdown";
import { canonicalDomain, encodeCanonical } from "./canonical";
import { sha256 } from "./auth";
import { cleanupU32, type CleanupResource } from "./cleanup.model.records";

/** Model-only parent capture digest; native typed inventory/OS custody encoding is still deferred. */
export function captureCleanupInventory(
  epoch: Uint8Array,
  op: RootOp,
  shutdownId: Uint8Array,
  ptys: readonly CleanupResource[],
  auxiliary: readonly CleanupResource[],
  ordinary: ReadonlyMap<string, string>,
) {
  const resource = (r: CleanupResource) => [
    r.identity,
    encodeCanonical("Generations", { main: r.generation, controller: "0", host: "0" }),
    Uint8Array.of(
      r.disposition === "pending"
        ? 1
        : r.disposition === "live"
          ? 2
          : r.disposition === "uncertain"
            ? 3
            : 4,
      Number(r.started),
    ),
  ];
  const cut = sha256(
    canonicalDomain("cleanup-cut-model/v2"),
    epoch,
    encodeCanonical("RootOp", op),
    shutdownId,
    cleanupU32(ordinary.size),
    ...[...ordinary].flatMap(([id, digest]) => [
      Uint8Array.from(Buffer.from(id, "hex")),
      Uint8Array.from(Buffer.from(digest, "hex")),
    ]),
    cleanupU32(ptys.length),
    ...ptys.flatMap(resource),
    cleanupU32(auxiliary.length),
    ...auxiliary.flatMap(resource),
  );
  const inventory: OwnerShutdownInventory = {
    binding: {
      version: 1,
      inventoryId: sha256(
        canonicalDomain("shutdown-inventory-id/v1"),
        epoch,
        shutdownId,
        encodeCanonical("RootOp", op),
      ),
      ownerEpoch: epoch,
      shutdownId,
      parentRootSequence: op.sequence,
      inventoryCut: cut,
    },
    ptys: ptys.map((r, slot) => ({
      slot,
      ptyId: r.identity,
      terminalGeneration: r.generation,
      resourceIdentity: r.identity,
    })),
  };
  return { cut, inventory };
}
