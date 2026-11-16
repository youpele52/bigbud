import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import {
  MOBILE_GATEWAY_CREDENTIAL_ENV,
  MOBILE_GATEWAY_CREDENTIAL_HEADER,
  matchesMobileGatewayCredential,
  rejectWithoutMobileGatewayCredential,
} from "./mobileGatewayCredential";

const CREDENTIAL = "gateway-credential-0123456789abcdefghij";

function check(env: Record<string, string>, headers: Record<string, string>) {
  const request = HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1:3773/mobile-ws?token=t", { headers }),
  );
  return rejectWithoutMobileGatewayCredential.pipe(
    Effect.provide(
      Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        Layer.succeed(HttpServerRequest.HttpServerRequest, request),
      ),
    ),
    Effect.map((rejection) => Option.map(rejection, (response) => response.status)),
  );
}

describe("mobileGatewayCredential", () => {
  it("compares credentials exactly", () => {
    expect(matchesMobileGatewayCredential(CREDENTIAL, CREDENTIAL)).toBe(true);
    expect(matchesMobileGatewayCredential(CREDENTIAL, `${CREDENTIAL}x`)).toBe(false);
    expect(matchesMobileGatewayCredential(CREDENTIAL, undefined)).toBe(false);
    expect(matchesMobileGatewayCredential("", "")).toBe(false);
  });

  it.effect("allows every request when no gateway credential is configured", () =>
    Effect.gen(function* () {
      expect(yield* check({}, {})).toEqual(Option.none());
    }),
  );

  it.effect("requires the configured credential on mobile routes", () =>
    Effect.gen(function* () {
      const env = { [MOBILE_GATEWAY_CREDENTIAL_ENV]: CREDENTIAL };
      expect(yield* check(env, { [MOBILE_GATEWAY_CREDENTIAL_HEADER]: CREDENTIAL })).toEqual(
        Option.none(),
      );
      expect(yield* check(env, {})).toEqual(Option.some(403));
      expect(yield* check(env, { [MOBILE_GATEWAY_CREDENTIAL_HEADER]: "forged" })).toEqual(
        Option.some(403),
      );
    }),
  );

  it.effect("fails closed when the configured value is empty", () =>
    Effect.gen(function* () {
      const env = { [MOBILE_GATEWAY_CREDENTIAL_ENV]: "" };
      expect(yield* check(env, { [MOBILE_GATEWAY_CREDENTIAL_HEADER]: "" })).toEqual(
        Option.some(403),
      );
    }),
  );
});
