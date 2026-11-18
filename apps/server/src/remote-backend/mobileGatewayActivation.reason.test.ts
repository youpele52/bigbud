import * as Cause from "effect/Cause";
import { expect, it } from "vitest";
import { MobileGatewayAdmissionRevoked } from "./mobileGatewayOwner.read.ts";
import { MobileGatewayNativeAdmissionRefused } from "./mobileGatewayNative.admission.ts";
import {
  classifyMobileActivationCause,
  mobileFailureDetail,
} from "./mobileGatewayActivation.reason.ts";

it("classifies a cause chain by error names only, never by message", () => {
  const route = Object.assign(Error("PRIVATE https://secret.example/path"), {
    name: "MobileGatewayRouteUnverified",
  });
  const wrapped = { _tag: "MobileGatewayOwnerError", message: "x", cause: route };
  expect(classifyMobileActivationCause(Cause.fail(wrapped))).toBe("route-unverified");
  expect(mobileFailureDetail(Cause.fail(wrapped))).toBe("MobileGatewayRouteUnverified");
  expect(
    classifyMobileActivationCause(new AggregateError([new MobileGatewayAdmissionRevoked("r")])),
  ).toBe("consent-revoked");
  expect(
    classifyMobileActivationCause({ cause: new MobileGatewayNativeAdmissionRefused("x") }),
  ).toBe("admission-refused");
  expect(classifyMobileActivationCause(Error("anything"))).toBe("unknown");
  expect(mobileFailureDetail(Error("anything"))).toBeNull();
  expect(mobileFailureDetail({ name: "has spaces and a token=abc" })).toBeNull();
});
