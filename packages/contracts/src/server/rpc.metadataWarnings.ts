import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import {
  AcknowledgeMetadataWarningInput,
  ClaimMetadataWarningsInput,
  ClaimMetadataWarningsResult,
  METADATA_WARNING_WS_METHODS,
  MetadataWarningDeliveryError,
} from "./metadataWarnings";

export const WsServerClaimMetadataWarningsRpc = Rpc.make(METADATA_WARNING_WS_METHODS.claim, {
  payload: ClaimMetadataWarningsInput,
  success: ClaimMetadataWarningsResult,
  error: MetadataWarningDeliveryError,
});

export const WsServerAcknowledgeMetadataWarningRpc = Rpc.make(
  METADATA_WARNING_WS_METHODS.acknowledge,
  {
    payload: AcknowledgeMetadataWarningInput,
    success: Schema.Boolean,
    error: MetadataWarningDeliveryError,
  },
);
