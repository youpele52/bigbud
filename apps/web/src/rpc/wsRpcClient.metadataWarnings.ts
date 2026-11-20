import { METADATA_WARNING_WS_METHODS } from "@bigbud/contracts/server/metadataWarnings.ts";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

import type { RpcUnaryMethod } from "./wsRpcClient.types";
import type { WsTransport } from "./wsTransport";

export interface MetadataWarningRpcMethods {
  readonly claimMetadataWarnings: RpcUnaryMethod<typeof METADATA_WARNING_WS_METHODS.claim>;
  readonly acknowledgeMetadataWarning: RpcUnaryMethod<
    typeof METADATA_WARNING_WS_METHODS.acknowledge
  >;
}

export function createMetadataWarningRpcMethods(transport: WsTransport): MetadataWarningRpcMethods {
  // A lost reply must not hold the consumer's single polling slot indefinitely. Delivery
  // retries are safe: only an owned, unexpired claim can acknowledge a persisted warning.
  const options = { timeout: Option.some(Duration.seconds(10)) };
  return {
    claimMetadataWarnings: (input) =>
      transport.request((client) => client[METADATA_WARNING_WS_METHODS.claim](input), options),
    acknowledgeMetadataWarning: (input) =>
      transport.request(
        (client) => client[METADATA_WARNING_WS_METHODS.acknowledge](input),
        options,
      ),
  };
}
