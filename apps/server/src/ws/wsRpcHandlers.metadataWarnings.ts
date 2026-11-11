import {
  type AcknowledgeMetadataWarningInput,
  type ClaimMetadataWarningsInput,
  METADATA_WARNING_CLAIM_MS,
  METADATA_WARNING_WS_METHODS,
  MetadataWarningDeliveryError,
} from "@bigbud/contracts/server/metadataWarnings.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { makeMetadataWarnings } from "../persistence/Layers/ThreadMetadataGeneration.warnings.ts";

const unavailable = Effect.fail(
  new MetadataWarningDeliveryError({
    code: "unavailable",
    message: "Text generation warnings are not available on this server.",
  }),
);
const failed = () =>
  new MetadataWarningDeliveryError({
    code: "failed",
    message: "Text generation warning delivery could not be saved. Please reconnect and try again.",
  });

/** Uses the existing persistence client; never runs generation or trusts client-supplied times. */
export const makeWsRpcMetadataWarningHandlers = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const warnings = Option.isSome(sql)
    ? yield* makeMetadataWarnings().pipe(Effect.provideService(SqlClient.SqlClient, sql.value))
    : null;
  const attributes = { "rpc.aggregate": "server" } as const;
  return {
    [METADATA_WARNING_WS_METHODS.claim]: (input: ClaimMetadataWarningsInput) =>
      observeRpcEffect(
        METADATA_WARNING_WS_METHODS.claim,
        warnings === null
          ? unavailable
          : Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                warnings.claimPendingWarnings({
                  clientId: input.clientId,
                  at: new Date(now).toISOString(),
                  until: new Date(now + METADATA_WARNING_CLAIM_MS).toISOString(),
                }),
              ),
              Effect.mapError(failed),
            ),
        attributes,
      ),
    [METADATA_WARNING_WS_METHODS.acknowledge]: (input: AcknowledgeMetadataWarningInput) =>
      observeRpcEffect(
        METADATA_WARNING_WS_METHODS.acknowledge,
        warnings === null
          ? unavailable
          : Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                warnings.acknowledgeWarning({ ...input, at: new Date(now).toISOString() }),
              ),
              Effect.mapError(failed),
            ),
        attributes,
      ),
  };
});
