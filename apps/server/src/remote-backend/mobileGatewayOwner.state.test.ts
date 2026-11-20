import { expect, it } from "vitest";
import { MobileGatewayOwnerState } from "./mobileGatewayOwner.state.ts";

it("remains unavailable while starting and invalidates synchronously before notification", () => {
  const state = new MobileGatewayOwnerState();
  expect(state.getPhase()).toBe("idle");
  const lease = state.begin();
  expect(lease.isAdmitted()).toBe(false);
  lease.admit();
  const observed: boolean[] = [];
  const unsubscribe = state.subscribe(() => observed.push(lease.isAdmitted()));
  lease.signal.addEventListener("abort", () => observed.push(lease.isAdmitted()));
  lease.invalidate("disabled");
  expect(observed).toEqual([false, false]);
  expect(state.getPhase()).toBe("revoking");
  expect(() => state.begin()).toThrow("settled");
  lease.settle(true);
  expect(state.getPhase()).toBe("idle");
  unsubscribe();
});

it("cannot reuse a retired lifetime or let its late settlement affect the replacement", () => {
  const state = new MobileGatewayOwnerState();
  const old = state.begin();
  old.admit();
  old.invalidate("revoked");
  old.invalidate("disabled");
  expect(old.endReason()).toBe("revoked");
  old.settle(true);
  const replacement = state.begin();
  replacement.admit();
  old.invalidate("revoked");
  old.settle(false);
  expect(replacement.isAdmitted()).toBe(true);
  expect(state.getPhase()).toBe("running");
  expect(() => old.admit()).toThrow("ended");
});

it("retains a repair fence when owned cleanup cannot confirm settlement", () => {
  const state = new MobileGatewayOwnerState();
  const lease = state.begin();
  lease.invalidate("disabled");
  lease.settle(false);
  expect(state.getPhase()).toBe("repair");
  expect(lease.isCurrent()).toBe(false);
  expect(() => state.begin()).toThrow("repair");
});
