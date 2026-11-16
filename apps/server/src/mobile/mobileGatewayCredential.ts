import { createHash, timingSafeEqual } from "node:crypto";

import { Config, Effect, Option, Redacted } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/**
 * Shared secret between the Rust mobile gateway and this backend. The launcher
 * generates it at startup and passes it to both processes. When it is set,
 * mobile routes (pairing, `/mobile-ws`, `/mobile` assets) accept only requests
 * the gateway forwarded, so another local process cannot impersonate it.
 * Unset keeps today's behavior for hosts without the gateway.
 */
export const MOBILE_GATEWAY_CREDENTIAL_ENV = "BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL";
export const MOBILE_GATEWAY_CREDENTIAL_HEADER = "x-bigbud-mobile-gateway";

const configuredMobileGatewayCredential = Config.redacted(MOBILE_GATEWAY_CREDENTIAL_ENV).pipe(
  Config.option,
);

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison; hashing first gives equal-length inputs. */
export function matchesMobileGatewayCredential(
  expected: string,
  presented: string | undefined,
): boolean {
  if (presented === undefined || expected.length === 0) return false;
  return timingSafeEqual(digest(expected), digest(presented));
}

/**
 * Some(403 response) when the gateway credential is configured and the
 * request does not carry it; None when the request may proceed.
 */
export const rejectWithoutMobileGatewayCredential = Effect.gen(function* () {
  const configured = yield* configuredMobileGatewayCredential
    .asEffect()
    // A malformed value must not silently disable enforcement: fail closed.
    .pipe(Effect.orElseSucceed(() => Option.some(Redacted.make(""))));
  if (Option.isNone(configured)) return Option.none<HttpServerResponse.HttpServerResponse>();
  const request = yield* HttpServerRequest.HttpServerRequest;
  const presented = request.headers[MOBILE_GATEWAY_CREDENTIAL_HEADER];
  return matchesMobileGatewayCredential(Redacted.value(configured.value), presented)
    ? Option.none<HttpServerResponse.HttpServerResponse>()
    : Option.some(HttpServerResponse.text("Forbidden", { status: 403 }));
});
