import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../startup/config.ts";
import { MobileGatewayProcessInput } from "./mobileGatewayProcess.config.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { validateMobileGatewayConfiguration } from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { serveSealedMobileUpstream } from "./mobileGatewayListener.upstream.ts";
import {
  mobileGatewayListenerUnavailable as unavailable,
  validateMobileGatewayListener,
} from "./mobileGatewayListener.prefix.ts";

/**
 * Explicit original-proof lifetime only. Reuse this backend's actual RPC services/boot lock;
 * no runtime/provider Layer is recreated and no credential or configuration escapes.
 */
export const runMobileGatewayListener = Effect.fn("runMobileGatewayListener")(function* (
  proof: VerifiedMobilePublication,
  input: MobileGatewayProcessInput,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const selected = yield* Effect.try({
        try: () => {
          const fixed = Object.freeze(
            Schema.decodeUnknownSync(MobileGatewayProcessInput)(input, {
              onExcessProperty: "error",
            }),
          );
          validateMobileGatewayConfiguration(fixed);
          return fixed;
        },
        catch: unavailable,
      });
      const { config, owner, gateway, assertAllowed } = yield* validateMobileGatewayListener(proof);
      const selectedConfig = yield* serveSealedMobileUpstream(
        config,
        owner,
        randomBytes(32).toString("hex"),
        assertAllowed,
      );
      // run returns only after its owned child/accepted work/cleanup settles, including repair failure.
      // Closing the private HTTP/socket afterward is safe credential denial even for uncertain exits;
      // gateway asset/CAS pins remain owned by the process's repair fence.
      yield* gateway.run(proof, selected).pipe(Effect.provideService(ServerConfig, selectedConfig));
    }),
  ).pipe(Effect.mapError(unavailable));
});

export type MobileGatewayListenerServices = Effect.Services<
  ReturnType<typeof runMobileGatewayListener>
>;
