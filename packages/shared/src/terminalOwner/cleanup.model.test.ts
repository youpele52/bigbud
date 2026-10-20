import { describe, expect, it } from "vitest";
import { saturatedCleanupModel } from "./cleanup.model.fixture";
import { id, vectors } from "./test.fixture";
import { cleanupGrantFixture, authenticateCleanupGrant } from "./cleanup.auth.fixture";
import { encodeCanonical } from "./canonical";

describe("full 512 KiB cleanup reservation model", () => {
  it.each([false, true])(
    "retains 248 ordinary + 1 parent + 112 children under saturation, pending=%s",
    // All child outcomes and reservation invariants are checked after every transition.
    { timeout: 15_000 },
    (pending) => {
      const { model, check, ordinary } = saturatedCleanupModel(pending);
      const op = { sequence: "249", attemptId: id(240), expectedAuthorityRevision: "248" };
      const parent = model.begin(op, id(241));
      expect(model.query(1, 63).id).toBe(vectors.expected.cleanupChildMax);
      check();
      expect(model.begin(op, id(241))).toEqual(parent);
      check();
      expect(() => model.begin({ ...op, attemptId: id(242) }, id(241))).toThrow("DIGEST_CONFLICT");
      expect(() => model.reserveResource("pty", id(243))).toThrow("ADMISSION_CLOSED");
      if (pending) {
        for (let i = 32; i < 63; i++) {
          model.completePending(i, i === 32 ? "uncertain" : i === 33 ? "clean" : "live");
          check();
        }
        expect(() => model.completePending(63, "live")).toThrow("ADMISSION_CLOSED");
        model.completePending(63, "clean");
        check();
      }
      const copies = model.reservations.cleanupCopies;
      const copy1 = copies.reserve(8192);
      const copy2 = copies.reserve(8192);
      check();
      expect(() => copies.reserve(1)).toThrow("CAPACITY");
      // Buffered completion loss is settled explicitly; retained outcomes do not depend on ACK.
      copies.release(copy1);
      copies.release(copy2);
      check();
      for (let i = 0; i < 64; i++) {
        const wire = copies.reserve(512);
        const child = model.accept(1, i, 39, id(i + 2), true);
        check();
        expect(model.accept(1, i, 39, id(i + 2), true)).toEqual(child);
        check();
        expect(model.query(1, i).id).toBe(child.id);
        expect(() => model.accept(1, i, 39, id(250), true)).toThrow("DIGEST_CONFLICT");
        model.disposition(1, i, true);
        check();
        copies.release(wire);
        check();
      }
      for (let i = 0; i < 30; i++) {
        model.accept(2, i, 0, id(i + 100), true);
        check();
        model.disposition(2, i, true);
        check();
      }
      const launch1 = model.reserveAttempt(1, 10, true);
      check();
      expect(model.reserveAttempt(1, 11, true)).toEqual(launch1);
      check();
      const grant1 = cleanupGrantFixture(model.inventorySnapshot());
      const capsule1 = encodeCanonical("CleanupGrantResult", grant1);
      const capsuleDigest = model.issueAttemptGrant(1, grant1, 12);
      expect(
        authenticateCleanupGrant(
          model.cleanupGrants(),
          grant1,
          model.inventorySnapshot(),
          12,
          check,
        ).state,
      ).toBe("ready");
      check();
      const replay1 = model.replayAttempt(1, 13, id(230));
      expect(replay1.bytes).toEqual(capsule1);
      check();
      expect(model.issueAttemptGrant(1, grant1, 14)).toBe(capsuleDigest);
      const replay2 = model.replayAttempt(1, 14, id(230));
      const others = Array.from({ length: 14 }, () => model.replayAttempt(1, 14, id(230)));
      check();
      expect(() => model.replayAttempt(1, 14, id(230))).toThrow("CAPACITY");
      replay1.release();
      check();
      replay2.release();
      for (const copy of others) copy.release();
      check();
      model.installVerifiedMainSession(id(229));
      check();
      expect(() => model.replayAttempt(1, 14, id(230))).toThrow("ROLE_DENIED");
      expect(() => model.replayAttempt(1, 14, id(229))).toThrow("ROLE_DENIED");
      check();
      expect(() => model.reserveAttempt(2, 15, true)).toThrow("ATTEMPT_BLOCKED");
      // Failed settlement/crash: cannot start next writer until independently proved stopped.
      model.stopAttempt(1, false);
      check();
      expect(model.readyToHandoff()).toBe(false);
      expect(() => model.reserveAttempt(2, 16, true)).toThrow("ATTEMPT_BLOCKED");
      model.stopAttempt(1, true);
      check();
      const launch2 = model.reserveAttempt(2, 17, true);
      check();
      expect(model.reserveAttempt(2, 18, true)).toEqual(launch2);
      check();
      const grant2 = cleanupGrantFixture(model.inventorySnapshot(), 2);
      const capsule2 = encodeCanonical("CleanupGrantResult", grant2);
      model.issueAttemptGrant(2, grant2, 19);
      expect(
        authenticateCleanupGrant(
          model.cleanupGrants(),
          grant2,
          model.inventorySnapshot(),
          19,
          check,
        ).state,
      ).toBe("ready");
      check();
      const secondReplay = model.replayAttempt(2, 20, id(229));
      expect(secondReplay.bytes).toEqual(capsule2);
      secondReplay.release();
      check();
      expect(() => model.reserveAttempt(3, 21, true)).toThrow("ATTEMPT_BLOCKED");
      for (const i of [0, 1, 2, 3, 5]) {
        model.accept(3, i, 0, id(i + 50), true);
        check();
        model.disposition(3, i, true);
        check();
      }
      for (const i of [9, 10, 12, 13]) {
        model.disposition(3, i, true);
        check();
      }
      model.retryObservation("500");
      check();
      const cut = model.freezeInventory();
      check();
      expect(() => model.reportFinalReceipt(id(33), id(34), 2, 22)).toThrow("RECEIPT_INVALID");
      model.reportFinalReceipt(cut, id(34), 2, 23);
      check();
      model.stopAttempt(2, true);
      check();
      for (let i = 0; i < 16; i++) {
        if ([0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14].includes(i)) continue;
        if (i === 8) {
          model.retryObservation("500");
          check();
          model.retryObservation("501");
          check();
          continue;
        }
        if ([9, 10, 11, 12, 13, 14].includes(i)) {
          model.disposition(3, i, true);
          check();
          continue;
        }
        model.accept(3, i, i === 6 ? 28 : 0, id(i + 50), true);
        check();
        model.disposition(3, i, true);
        check();
      }
      const confirmed = model.query(3, 6);
      expect(model.accept(3, 6, 28, id(56), true).id).toBe(confirmed.id);
      check();
      const finalized = model.accept(3, 7, 22, id(57), true);
      check();
      model.disposition(3, 7, true);
      check();
      expect(model.accept(3, 7, 22, id(57), true).id).toBe(finalized.id);
      check();
      const final = check();
      expect(final.ready).toBe(true);
      expect(final.rootRecords).toBe(249);
      expect(final.children).toHaveLength(112);
      expect(final.ordinary).toEqual(ordinary);
      expect(model.reservations.authorityRoot.snapshot().items).toBe(0);
      for (let i = 0; i < 7; i++) model.reservations.authorityRoot.reserve(1024);
      expect(check().rootRecords).toBe(256);
    },
  );
  it("failed admission does not commit digest; unknown/expired attempts never release pins or restart", () => {
    const { model, check } = saturatedCleanupModel(false);
    model.begin({ sequence: "249", attemptId: id(240), expectedAuthorityRevision: "248" }, id(241));
    check();
    expect(() => model.accept(1, 0, 39, id(44), false)).toThrow("PRECONDITION_FAILED");
    expect(model.query(1, 0).digest).toBeUndefined();
    model.accept(1, 0, 39, id(45), true);
    model.disposition(1, 0, false);
    check();
    expect(model.accept(1, 0, 39, id(45), true).effects).toBe(1);
    check();
    model.reserveAttempt(1, 0, true);
    model.issueAttemptGrant(1, cleanupGrantFixture(model.inventorySnapshot()), 1);
    check();
    expect(() => model.replayAttempt(1, 30000, id(230))).toThrow("ATTEMPT_EXPIRED");
    model.stopAttempt(1, true);
    model.reserveAttempt(2, 30001, true);
    model.issueAttemptGrant(2, cleanupGrantFixture(model.inventorySnapshot(), 2), 30002);
    check();
    expect(() => model.freezeInventory()).toThrow("SETTLEMENT_PENDING");
    expect(() => model.reportFinalReceipt(model.parentStatus().cut, id(3), 2, 60001)).toThrow(
      "RECEIPT_INVALID",
    );
    expect(() => model.reserveAttempt(3, 60002, true)).toThrow("ATTEMPT_BLOCKED");
    expect(() => model.accept(3, 7, 22, id(4), true)).toThrow("CLEANUP_UNKNOWN");
    expect(check().ready).toBe(false);
    expect(check().children).toHaveLength(112);
    expect(model.query(1, 0).state).toBe("cleanupUnknown");
  });
});
