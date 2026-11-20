import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../core/baseSchemas";
import { MetadataGenerationWarning } from "../orchestration/orchestration.metadataGeneration";

export const METADATA_WARNING_CLAIM_MS = 60_000;

export const METADATA_WARNING_WS_METHODS = {
  claim: "server.claimMetadataWarnings",
  acknowledge: "server.acknowledgeMetadataWarning",
} as const;

/** A renderer-lifetime identity, retained across reconnects but not shared by windows. */
export const ClaimMetadataWarningsInput = Schema.Struct({
  clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type ClaimMetadataWarningsInput = typeof ClaimMetadataWarningsInput.Type;
export const ClaimMetadataWarningsResult = Schema.Array(MetadataGenerationWarning).check(
  Schema.isMaxLength(10),
);
export type ClaimMetadataWarningsResult = typeof ClaimMetadataWarningsResult.Type;

export const AcknowledgeMetadataWarningInput = Schema.Struct({
  ...ClaimMetadataWarningsInput.fields,
  warningId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type AcknowledgeMetadataWarningInput = typeof AcknowledgeMetadataWarningInput.Type;

export class MetadataWarningDeliveryError extends Schema.TaggedErrorClass<MetadataWarningDeliveryError>()(
  "MetadataWarningDeliveryError",
  {
    code: Schema.Literals(["unavailable", "failed"]),
    message: TrimmedNonEmptyString,
  },
) {}

export interface MetadataWarningsNativeApi {
  readonly claimMetadataWarnings: (
    input: ClaimMetadataWarningsInput,
  ) => Promise<ClaimMetadataWarningsResult>;
  readonly acknowledgeMetadataWarning: (input: AcknowledgeMetadataWarningInput) => Promise<boolean>;
}
