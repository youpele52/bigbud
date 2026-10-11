import { expect } from "vitest";
import { OwnerCleanupModel } from "./cleanup.model";
import { id, hex } from "./test.fixture";
import { encodeCanonical } from "./canonical";

/** Full ordinary pools stay pinned for the entire test; no test-side eviction. */
export function saturatedCleanupModel(pending: boolean) {
  const model = new OwnerCleanupModel(id(1), id(230));
  const r = model.reservations;
  for (let i = 0; i < 248; i++) model.admitOrdinary(hex(id(i + 1)), hex(id(255 - i)), 1024);
  for (let i = 0; i < 126; i++) r.ordinaryGrants.reserve(i === 125 ? 1036 : 516);
  for (let i = 0; i < 256; i++) r.ordinaryResponses.reserve(4096);
  for (let i = 0; i < 128; i++) r.activeMutations.reserve(1);
  for (let i = 0; i < 64; i++) r.bulkTickets.reserve(512);
  r.ordinaryCopies.reserve(65536);
  r.ordinaryCopies.reserve(32768);
  expect(() => model.admitOrdinary(hex(id(250)), hex(id(251)), 1024)).toThrow("CAPACITY");
  expect(() => r.ordinaryGrants.reserve(1)).toThrow("CAPACITY");
  expect(() => r.ordinaryResponses.reserve(1)).toThrow("CAPACITY");
  expect(() => r.activeMutations.reserve(1)).toThrow("CAPACITY");
  expect(() => r.bulkTickets.reserve(1)).toThrow("CAPACITY");
  for (let i = 0; i < 64; i++)
    model.reserveResource("pty", id(i + 2), pending && i >= 32 ? "pending" : "live", i !== 63);
  for (let i = 0; i < 30; i++) model.reserveResource("auxiliary", id(i + 100), "live");
  expect(() => model.reserveResource("pty", id(200))).toThrow("CAPACITY");
  expect(() => model.reserveResource("auxiliary", id(201))).toThrow("CAPACITY");
  const ordinary = model.snapshot().ordinary;
  const check = () => {
    const snapshot = model.snapshot();
    expect(snapshot.ordinary).toEqual(ordinary);
    expect(snapshot.floor).toBe("0");
    expect(snapshot.rootEnvelope).toEqual({
      ledger: 262144,
      arena: 131072,
      copies: 114688,
      bookkeeping: 16384,
      total: 524288,
    });
    expect(r.ordinaryRoot.snapshot()).toMatchObject({ bytes: 253952, items: 248 });
    expect(r.ordinaryGrants.snapshot()).toMatchObject({ bytes: 65536, items: 126 });
    expect(r.ordinaryCopies.snapshot().bytes).toBe(98304);
    expect(r.cleanupCopies.snapshot().bytes).toBeLessThanOrEqual(16384);
    expect(r.cleanupCopies.snapshot().items).toBeLessThanOrEqual(16);
    expect(snapshot.rootRecords).toBeLessThanOrEqual(256);
    expect(snapshot.children.length).toBeLessThanOrEqual(112);
    expect(snapshot.ptys).toBeLessThanOrEqual(64);
    expect(snapshot.auxiliary).toBeLessThanOrEqual(32);
    expect(snapshot.attempts).toBeLessThanOrEqual(2);
    expect(snapshot.capsules).toBeLessThanOrEqual(2);
    if (snapshot.children.length) {
      const grants = model.cleanupGrants().snapshot();
      expect(grants.grants).toBeLessThanOrEqual(2);
      expect(grants.grants + r.ordinaryGrants.snapshot().items).toBeLessThanOrEqual(128);
      expect(grants.capsuleBytes).toBeLessThanOrEqual(16384);
    }
    for (const c of snapshot.children) {
      expect(c.effects).toBeLessThanOrEqual(1);
      expect(c.id.length).toBe(64);
      const state = { reserved: 1, accepted: 2, succeeded: 4, cleanupUnknown: 7 }[c.state];
      const encoded = encodeCanonical("CleanupOutcome", {
        child: c.ref,
        childId: Uint8Array.from(Buffer.from(c.id, "hex")),
        mutationDigest: c.digest ? Uint8Array.from(Buffer.from(c.digest, "hex")) : id(0),
        state,
        dispositionDigest: id(0),
        resultCapsuleDigest: id(0),
        authorityRevision: "248",
      });
      expect(encoded.length).toBeLessThanOrEqual(r.childOutcomeBytes);
      // Fixed model index/state allowance, not measured JS object/native allocator overhead.
      expect(encoded.length + 256).toBeLessThanOrEqual(r.childRecordBytes);
    }
    return snapshot;
  };
  return { model, check, ordinary };
}
