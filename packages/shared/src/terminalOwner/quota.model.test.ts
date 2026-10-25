import { expect, it } from "vitest";
import { OwnerConnectionQuotaModel } from "./quota.model";

it("rejects self/nonbulk/reciprocal parent edges without changing reservations", () => {
  const model = new OwnerConnectionQuotaModel();
  const a = model.accept("public", 0);
  const b = model.accept("public", 0);
  const before = model.snapshot();
  for (const destination of [
    "backend",
    "host",
    "hostTelemetry",
    "rootControl",
    "rootStatus",
    "mainTelemetry",
    "cleanupControl",
    "cleanupStatus",
  ] as const) {
    expect(() => model.reserve(a, destination, true, b, "1")).toThrow("ROLE_DENIED");
    expect(model.snapshot()).toEqual(before);
    expect(model.countDestination(destination)).toBe(0);
  }
  for (const [child, parent] of [
    [a, a],
    [a, b],
    [b, a],
  ]) {
    expect(() => model.reserve(child!, "backend", true, parent, "1")).toThrow("ROLE_DENIED");
    expect(model.snapshot()).toEqual(before);
    expect(model.countDestination("backend")).toBe(0);
  }
  expect(() => model.reserve(a, "backendBulk", true, a, "1")).toThrow("ROLE_DENIED");
  model.reserve(a, "backend", true, undefined, "1");
  model.promote(a, 1);
  const reserved = model.snapshot();
  expect(() => model.reserve(b, "backendBulk", true, a, "2")).toThrow("ROLE_DENIED");
  expect(model.snapshot()).toEqual(reserved);
  model.close(a);
  model.close(b);
  expect(model.snapshot().physical).toBe(0);
});

it("public saturation cannot borrow recovery/cleanup promotion or accepts", () => {
  const model = new OwnerConnectionQuotaModel();
  const publicIds = Array.from({ length: 32 }, () => model.accept("public", 0));
  expect(() => model.accept("public", 0)).toThrow("CAPACITY");
  expect(() => model.reserve(publicIds[0]!, "rootControl", true)).toThrow("ROLE_DENIED");
  const root = model.accept("root", 0);
  model.reserve(root, "rootControl", true);
  const candidate = model.accept("root", 0);
  model.reserve(candidate, "rootControl", true);
  const cleanup = model.accept("cleanup", 0);
  model.reserve(cleanup, "cleanupControl", true);
  model.promote(root, 1);
  model.promote(cleanup, 1);
  expect(model.snapshot()).toEqual({ physical: 35, promotionOrAuthenticated: 3, preAuth: 33 });
  model.expire(5000);
  expect(model.snapshot()).toEqual({ physical: 2, promotionOrAuthenticated: 2, preAuth: 0 });
  model.close(root);
  model.close(root);
  model.close(cleanup);
  expect(model.snapshot().physical).toBe(0);
});

it("expiry/cancel retains an in-use auth reservation until actual completion", () => {
  const model = new OwnerConnectionQuotaModel();
  const id = model.accept("root", 0);
  model.reserve(id, "rootControl", true);
  model.beginWork(id);
  model.expire(5000);
  expect(model.snapshot()).toEqual({ physical: 1, promotionOrAuthenticated: 1, preAuth: 1 });
  expect(() => model.promote(id, 5000)).toThrow();
  model.settleWork(id);
  expect(model.snapshot().physical).toBe(0);
});

it("reservations promote without a release gap; bulk respects parent and count ceilings", () => {
  const model = new OwnerConnectionQuotaModel();
  const parent = model.accept("public", 0);
  model.reserve(parent, "backend", true, undefined, "1");
  model.promote(parent, 1);
  for (let i = 0; i < 2; i++) {
    const child = model.accept("public", 2);
    model.reserve(child, "backendBulk", true, parent, "1");
    model.promote(child, 3);
  }
  const third = model.accept("public", 4);
  expect(() => model.reserve(third, "backendBulk", true, parent, "1")).toThrow("CAPACITY");
  expect(() => model.reserve(third, "hostBulk", true, parent, "1")).toThrow("ROLE_DENIED");
  model.close(third);
  model.close(parent);
  expect(model.snapshot().physical).toBe(0);
});
