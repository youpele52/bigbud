import { expect, it } from "vitest";
import { assertV2RebootBoundary } from "./RebootRecovery.host.ts";

const before = {
  host: "a".repeat(64),
  bootSession: "11111111-1111-1111-1111-111111111111",
  bootSeconds: 100,
  bootMicroseconds: 1,
};
it("requires both an authoritative new boot session and forward boot time on the prepared host", () => {
  expect(() => assertV2RebootBoundary(before, { ...before })).toThrow("same boot");
  expect(() => assertV2RebootBoundary(before, { ...before, bootSeconds: 200 })).toThrow();
  expect(() =>
    assertV2RebootBoundary(before, {
      ...before,
      bootSession: "22222222-2222-2222-2222-222222222222",
    }),
  ).toThrow();
  expect(() =>
    assertV2RebootBoundary(before, {
      ...before,
      host: "b".repeat(64),
      bootSeconds: 200,
      bootSession: "22222222-2222-2222-2222-222222222222",
    }),
  ).toThrow("host changed");
  expect(() =>
    assertV2RebootBoundary(before, {
      ...before,
      bootSeconds: 200,
      bootSession: "22222222-2222-2222-2222-222222222222",
    }),
  ).not.toThrow();
});
