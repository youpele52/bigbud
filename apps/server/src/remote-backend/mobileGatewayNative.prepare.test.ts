import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { makeNativeMobileGatewayLaunchPreparation } from "./mobileGatewayNative.prepare.ts";

it("requires no proof, configuration or runtime services when no managed adapter is supplied", async () => {
  const effect = makeNativeMobileGatewayLaunchPreparation();
  expect(await Effect.runPromise(effect)).toBe(null);
});
