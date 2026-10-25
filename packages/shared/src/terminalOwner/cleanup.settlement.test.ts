import { expect, it } from "vitest";
import { OwnerCleanupModel } from "./cleanup.model";
import { id } from "./test.fixture";
import { cleanupGrantFixture } from "./cleanup.auth.fixture";

function fixture() {
  const model = new OwnerCleanupModel(id(1), id(230));
  model.reserveResource("pty", id(2), "live");
  model.begin({ sequence: "1", attemptId: id(3), expectedAuthorityRevision: "0" }, id(4));
  model.reserveAttempt(1, 0, true);
  model.issueAttemptGrant(1, cleanupGrantFixture(model.inventorySnapshot()), 1);
  return model;
}
function settleOrdinary(model: OwnerCleanupModel) {
  for (const c of model.snapshot().children) {
    const { class: kind, slot } = c.ref;
    if ((kind === 2 && slot === 30) || (kind === 3 && [4, 6, 7, 11, 15].includes(slot))) continue;
    if (kind === 3 && slot === 8) {
      model.retryObservation("1");
      continue;
    }
    if (!c.digest) model.accept(kind, slot, kind === 1 ? 39 : 0, id(2), true);
    model.disposition(kind, slot, true);
  }
}
function finishMetadata(model: OwnerCleanupModel) {
  for (const slot of [6, 15]) {
    model.accept(3, slot, slot === 6 ? 28 : 0, id(slot), true);
    model.disposition(3, slot, true);
  }
  model.accept(3, 7, 22, id(7), true);
  model.disposition(3, 7, true);
}

it("rejects final freeze and receipt while captured PTY is live/uncertain", () => {
  const model = fixture();
  const inventory = model.inventorySnapshot();
  const parent = model.parentStatus();
  expect(() => model.freezeInventory()).toThrow("SETTLEMENT_PENDING");
  expect(() => model.reportFinalReceipt(parent.cut, id(10), 1, 2)).toThrow("RECEIPT_INVALID");
  const child = model.accept(1, 0, 39, id(2), true);
  model.disposition(1, 0, false);
  expect(() => model.freezeInventory()).toThrow("SETTLEMENT_PENDING");
  expect(model.accept(1, 0, 39, id(2), true).id).toBe(child.id);
  expect(model.query(1, 0).effects).toBe(1);
  expect(model.readyToHandoff()).toBe(false);
  settleOrdinary(model);
  const cut = model.freezeInventory();
  expect(cut).not.toEqual(parent.cut);
  expect(model.inventorySnapshot()).toEqual(inventory);
});

it("invalidates old receipt on uncertain writer/outcome change; later clean state cannot reuse it", () => {
  const model = fixture();
  settleOrdinary(model);
  const cut = model.freezeInventory();
  model.reportFinalReceipt(cut, id(10), 1, 2);
  const before = model.snapshot().settlement;
  model.stopAttempt(1, false);
  const changed = model.snapshot().settlement;
  expect(changed.outcomeCut).not.toBe(before.outcomeCut);
  expect(changed.receipt).toBeUndefined();
  model.stopAttempt(1, true);
  expect(() => model.reportFinalReceipt(cut, id(10), 1, 3)).toThrow("RECEIPT_INVALID");
  expect(() => finishMetadata(model)).toThrow("RECEIPT_INVALID");
  expect(model.readyToHandoff()).toBe(false);
});

it("preserves matching receipt only for named writer verified exit and harmless lost ACK metadata", () => {
  const model = fixture();
  settleOrdinary(model);
  const cut = model.freezeInventory();
  model.reportFinalReceipt(cut, id(10), 1, 2);
  const sealed = model.snapshot().settlement;
  const beforeConflict = model.snapshot();
  expect(() => model.reportFinalReceipt(cut, id(11), 1, 3)).toThrow("DIGEST_CONFLICT");
  expect(model.snapshot()).toEqual(beforeConflict);
  model.reportFinalReceipt(cut, id(10), 1, 3);
  const child = model.query(1, 0);
  model.accept(1, 0, 39, id(2), true);
  model.disposition(1, 0, true);
  model.retryObservation("2");
  expect(model.snapshot().settlement).toEqual(sealed);
  expect(model.query(1, 0)).toEqual(child);
  expect(model.readyToHandoff()).toBe(false);
  model.stopAttempt(1, true);
  finishMetadata(model);
  expect(model.snapshot().settlement).toEqual(sealed);
  expect(model.freezeInventory()).toEqual(cut);
  expect(model.readyToHandoff()).toBe(true);
  expect(model.query(1, 0).effects).toBe(1);
});

it("refreezing after unknown confirmation cannot publish a rejected receipt over the immutable receipt child", () => {
  const model = fixture();
  settleOrdinary(model);
  const cut = model.freezeInventory();
  model.reportFinalReceipt(cut, id(10), 1, 2);
  const receiptChild = model.query(3, 4);
  const child = model.accept(3, 6, 28, id(6), true);
  model.disposition(3, 6, false);
  expect(model.snapshot().settlement.receipt).toBeUndefined();
  model.disposition(3, 6, true);
  expect(model.query(3, 6).id).toBe(child.id);
  expect(model.query(3, 6).effects).toBe(1);
  expect(() => model.reportFinalReceipt(cut, id(10), 1, 3)).toThrow("RECEIPT_INVALID");
  const refrozen = model.freezeInventory();
  expect(refrozen).not.toEqual(cut);
  const beforeRejectedReport = model.snapshot();
  const beforeCopies = model.reservations.cleanupCopies.snapshot();
  expect(beforeRejectedReport.settlement.receipt).toBeUndefined();
  expect(() => model.reportFinalReceipt(refrozen, id(11), 1, 4)).toThrow("DIGEST_CONFLICT");
  expect(model.snapshot()).toEqual(beforeRejectedReport);
  expect(model.reservations.cleanupCopies.snapshot()).toEqual(beforeCopies);
  expect(model.query(3, 4)).toEqual(receiptChild);
  model.stopAttempt(1, true);
  expect(() => finishMetadata(model)).toThrow("CLEANUP_UNKNOWN");
  expect(model.query(2, 30).state).toBe("succeeded");
  expect(model.query(3, 11).state).toBe("succeeded");
  expect(model.query(3, 15).state).toBe("succeeded");
  expect(model.query(3, 4)).toEqual(receiptChild);
  expect(model.snapshot().settlement.receipt).toBeUndefined();
  expect(model.readyToHandoff()).toBe(false);
});
