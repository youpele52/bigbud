import { Schema } from "effect";
import { expect, it } from "vitest";
import { OwnerShutdownInventory, ShutdownInventoryBinding } from "./shutdown";
import { Scope } from "./identity";

it("bounds schema-only owner-held inventory at 64 without widening ordinary 32-entry scopes", () => {
  const id = (byte: number) => new Uint8Array(32).fill(byte);
  const binding = {
    version: 1,
    inventoryId: id(1),
    ownerEpoch: id(2),
    shutdownId: id(3),
    parentRootSequence: "249",
    inventoryCut: id(4),
  };
  const ptys = Array.from({ length: 64 }, (_, slot) => ({
    slot,
    ptyId: id(11 + slot),
    terminalGeneration: "1",
    resourceIdentity: id(100 + slot),
  }));
  expect(Schema.decodeUnknownSync(OwnerShutdownInventory)({ binding, ptys }).ptys).toHaveLength(64);
  expect(() =>
    Schema.decodeUnknownSync(OwnerShutdownInventory)({ binding, ptys: [...ptys, ptys[0]] }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ShutdownInventoryBinding)({ ...binding, version: 2 }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ShutdownInventoryBinding)({ ...binding, inventoryId: id(0) }),
  ).toThrow();
  const scope = {
    role: 2,
    use: 1,
    revision: "1",
    generations: { main: "1", controller: "1", host: "0" },
    process: { os: 1, pid: "100", birth: id(1), ownerEpoch: id(2) },
    artifactSetDigest: id(3),
    createBudget: 0,
    capabilities: [9],
    shutdownId: id(0),
    ptys: ptys.map((p) => ({
      ownerEpoch: id(2),
      ptyId: p.ptyId,
      terminalGeneration: "1",
      capabilities: [9],
    })),
  };
  expect(
    Schema.decodeUnknownSync(Scope)({ ...scope, ptys: scope.ptys.slice(0, 32) }).ptys,
  ).toHaveLength(32);
  expect(() =>
    Schema.decodeUnknownSync(Scope)({ ...scope, ptys: scope.ptys.slice(0, 33) }),
  ).toThrow();
});
