import { expect, test } from "vitest";
import { organizationNativeBinary } from "./organizationNative.config.ts";

test("headless organisation ignores the delivery disabled gate", () => {
  expect(
    organizationNativeBinary(
      {
        BIGBUD_DESKTOP_SUPERVISOR_ENABLED: "0",
        BIGBUD_DESKTOP_SUPERVISOR_BINARY: "/fixture/native",
      },
      (path) => path === "/fixture/native",
    ),
  ).toBe("/fixture/native");
});
test("explicit missing binary fails closed without choosing another artifact", () => {
  expect(
    organizationNativeBinary({ BIGBUD_THREAD_ORGANIZATION_BINARY: "/missing" }, () => false),
  ).toBeUndefined();
});
test("organisation override wins over the delivery artifact", () => {
  expect(
    organizationNativeBinary(
      {
        BIGBUD_THREAD_ORGANIZATION_BINARY: "/organisation",
        BIGBUD_DESKTOP_SUPERVISOR_BINARY: "/delivery",
      },
      () => true,
    ),
  ).toBe("/organisation");
});
