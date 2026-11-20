import { Schema } from "effect";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
} from "./mobileGatewayLifecycle.schema.ts";

export const MAX_MOBILE_ACTIVATION_SELECTIONS = 16;
export const MobileActivationRequestId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
);
const PositiveCounter = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const MobileGatewayDesiredSelection = Schema.Struct({
  requestId: MobileActivationRequestId,
  revision: PositiveCounter,
  releaseId: Schema.String.check(Schema.isPattern(/^mobile-release:[a-f0-9]{64}$/)),
  stageId: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/)),
  consentRevision: PositiveCounter,
  configuration: MobileGatewayConfiguration,
});
export type MobileGatewayDesiredSelection = typeof MobileGatewayDesiredSelection.Type;

interface SelectionReferences {
  readonly desired?: MobileGatewayDesiredSelection | undefined;
  readonly desiredHistory?: readonly MobileGatewayDesiredSelection[] | undefined;
  /** Retired history rows (a prefix, with their stages); revisions stay continuous. */
  readonly retired?: { readonly selections: number } | undefined;
  readonly consent: { readonly revision: number };
  readonly stages: readonly {
    readonly id: string;
    readonly releaseId: string;
    readonly consentRevision: number;
    readonly phase: string;
    readonly publicationReceipt?: unknown;
  }[];
}
/** Persisted selection is desired state, never child/readiness/signature authority. */
export function validateMobileGatewaySelections(mobile: SelectionReferences): void {
  const history = mobile.desiredHistory ?? [];
  if (
    (!mobile.desired && history.length) ||
    history.length + Number(!!mobile.desired) > MAX_MOBILE_ACTIVATION_SELECTIONS
  )
    throw Error("Mobile desired-selection history exceeds its admitted lifetime budget.");
  const seen = new Set<string>();
  const offset = mobile.retired?.selections ?? 0;
  for (const [index, selected] of [
    ...history,
    ...(mobile.desired ? [mobile.desired] : []),
  ].entries()) {
    validateMobileGatewayConfiguration(selected.configuration);
    const stage = mobile.stages.find((entry) => entry.id === selected.stageId);
    if (
      selected.revision !== offset + index + 1 ||
      seen.has(selected.requestId) ||
      selected.consentRevision > mobile.consent.revision ||
      !stage ||
      stage.releaseId !== selected.releaseId ||
      stage.consentRevision !== selected.consentRevision ||
      !stage.publicationReceipt ||
      !["files-published", "cancelled"].includes(stage.phase)
    )
      throw Error("Invalid mobile desired selection or authenticated publication reference.");
    seen.add(selected.requestId);
  }
}
