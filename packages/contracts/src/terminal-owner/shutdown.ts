import { Schema } from "effect";
import { Id, IssuedId, U32, U64 } from "./primitives";

/** Prototype v1.1 reference to the owner's immutable BeginQuiesce inventory, never a caller allowset. */
export const ShutdownInventoryBinding = Schema.Struct({
  version: Schema.Literal(1),
  inventoryId: IssuedId,
  ownerEpoch: IssuedId,
  shutdownId: IssuedId,
  parentRootSequence: U64,
  inventoryCut: Id,
});
export type ShutdownInventoryBinding = typeof ShutdownInventoryBinding.Type;
export const ShutdownPtyReservation = Schema.Struct({
  slot: U32,
  ptyId: IssuedId,
  terminalGeneration: U64,
  resourceIdentity: Id,
});
/** Owner-held lookup record. This bounded list is not embedded in the grant or handshake. */
export const OwnerShutdownInventory = Schema.Struct({
  binding: ShutdownInventoryBinding,
  ptys: Schema.Array(ShutdownPtyReservation).check(Schema.isMaxLength(64)),
});
export type OwnerShutdownInventory = typeof OwnerShutdownInventory.Type;
