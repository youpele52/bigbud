import type { Scope } from "@bigbud/contracts/terminal-owner/identity";
import type { OwnerShutdownInventory } from "@bigbud/contracts/terminal-owner/shutdown";
import { encodeCanonical } from "./canonical";
import { equalBytes } from "./canonical.validation";
import { requireContract } from "./errors";

/** Lookup authority is an owner-owned immutable copy, not a peer's list or scope claim. */
export class OwnerShutdownInventoryModel {
  private readonly inventory: OwnerShutdownInventory;
  constructor(ownerHeld: OwnerShutdownInventory) {
    encodeCanonical("OwnerShutdownInventory", ownerHeld);
    this.inventory = structuredClone(ownerHeld);
  }
  authorizeScope(scope: Scope) {
    encodeCanonical("Scope", scope);
    requireContract(
      scope.role === 4 &&
        scope.cleanupInventory &&
        equalBytes(
          encodeCanonical("ShutdownInventoryBinding", scope.cleanupInventory),
          encodeCanonical("ShutdownInventoryBinding", this.inventory.binding),
        ),
      "INVENTORY_DENIED",
    );
  }
  authorizePty(scope: Scope, id: Uint8Array, generation: string) {
    this.authorizeScope(scope);
    requireContract(
      this.inventory.ptys.some(
        (entry) => equalBytes(entry.ptyId, id) && entry.terminalGeneration === generation,
      ),
      "INVENTORY_DENIED",
    );
  }
  snapshot() {
    return structuredClone(this.inventory);
  }
}
