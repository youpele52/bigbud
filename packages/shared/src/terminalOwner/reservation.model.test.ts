import { expect, it } from "vitest";
import { OwnerReservationModel } from "./reservation.model";

it("enforces individual ceilings before mutating every reservation pool", () => {
  const model = new OwnerReservationModel();
  for (const pool of [
    model.ordinaryRoot,
    model.authorityRoot,
    model.cleanupParent,
    model.ordinaryGrants,
    model.ordinaryResponses,
    model.activeMutations,
    model.bulkTickets,
    model.ordinaryCopies,
    model.cleanupCopies,
  ]) {
    const before = pool.snapshot();
    expect(() => pool.reserve(pool.perItemCap + 1)).toThrow("CAPACITY");
    expect(pool.snapshot()).toEqual(before);
    const permit = pool.reserve(pool.perItemCap);
    pool.release(permit);
    expect(pool.snapshot()).toEqual(before);
  }
  const before = model.ordinaryResponses.snapshot();
  expect(() => model.ordinaryResponses.reserve(4097)).toThrow("CAPACITY");
  expect(model.ordinaryResponses.snapshot()).toEqual(before);
  const maximum = model.ordinaryResponses.reserve(4096);
  expect(model.ordinaryResponses.snapshot().bytes).toBe(4096);
  model.ordinaryResponses.release(maximum);
});
