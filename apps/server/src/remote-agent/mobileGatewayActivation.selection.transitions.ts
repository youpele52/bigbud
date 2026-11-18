import { Schema } from "effect";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { mobileRegistryOwnerEqual } from "./remoteAgentInstall.mobile.schema.ts";
import type { MobileRegistryContext } from "./remoteAgentInstall.mobile.transitions.ts";
import {
  MAX_MOBILE_ACTIVATION_SELECTIONS,
  MobileActivationRequestId,
  type MobileGatewayDesiredSelection,
} from "./mobileGatewayActivation.selection.schema.ts";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
} from "./mobileGatewayLifecycle.schema.ts";

export interface MobileGatewaySelectionContext extends MobileRegistryContext {
  readonly stageId: string;
  readonly releaseId: string;
}
export interface MobileGatewaySelectionRequest {
  readonly requestId: string;
  readonly configuration: MobileGatewayConfiguration;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function findMobileGatewaySelection(
  state: RemoteAgentRegistry,
  requestId: string,
): { readonly selection: MobileGatewayDesiredSelection; readonly retired: boolean } | undefined {
  if (state.schemaVersion !== 3) return;
  if (state.mobile.desired?.requestId === requestId)
    return { selection: state.mobile.desired, retired: false };
  const selection = state.mobile.desiredHistory?.find((row) => row.requestId === requestId);
  return selection ? { selection, retired: true } : undefined;
}

/** Pure state transition. Production admission must supply context from the original publication proof. */
export function selectMobileGatewayDesired(
  state: RemoteAgentRegistry,
  context: MobileGatewaySelectionContext,
  input: MobileGatewaySelectionRequest,
): RemoteAgentRegistry {
  const requestId = Schema.decodeUnknownSync(MobileActivationRequestId)(input.requestId);
  const configuration = Schema.decodeUnknownSync(MobileGatewayConfiguration)(input.configuration, {
    onExcessProperty: "error",
  });
  validateMobileGatewayConfiguration(configuration);
  if (
    state.schemaVersion !== 3 ||
    !mobileRegistryOwnerEqual(state.mobile.owner, context.owner) ||
    !state.mobile.consent.enabled ||
    state.mobile.consent.revision !== context.expectedConsentRevision
  )
    throw Error("Gateway selection requires current actual owner and separate consent revision.");
  const stage = state.mobile.stages.find((row) => row.id === context.stageId);
  if (
    !stage ||
    stage.releaseId !== context.releaseId ||
    stage.consentRevision !== context.expectedConsentRevision ||
    stage.phase !== "files-published" ||
    !stage.publicationReceipt
  )
    throw Error("Gateway selection requires the original current published component pair.");
  const prior = findMobileGatewaySelection(state, requestId);
  if (prior) {
    const row = prior.selection;
    if (
      row.releaseId !== context.releaseId ||
      row.stageId !== context.stageId ||
      row.consentRevision !== context.expectedConsentRevision ||
      !same(row.configuration, configuration)
    )
      throw Error("Activation request ID was already used for another immutable tuple.");
    if (prior.retired)
      throw Error("Retired activation request cannot launch or become current again.");
    return state;
  }
  const history = [
    ...(state.mobile.desiredHistory ?? []),
    ...(state.mobile.desired ? [state.mobile.desired] : []),
  ];
  if (history.length + 1 > MAX_MOBILE_ACTIVATION_SELECTIONS)
    throw Error("Gateway desired-selection lifetime budget is full; admitted repair required.");
  if (state.mobile.gatewayLifecycle?.attempts.some((row) => row.phase !== "exit-confirmed"))
    throw Error(
      "Gateway replacement requires exact prior child cleanup; preserve uncertain ownership.",
    );
  const desired: MobileGatewayDesiredSelection = {
    requestId,
    revision: (state.mobile.desired?.revision ?? 0) + 1,
    releaseId: context.releaseId,
    stageId: context.stageId,
    consentRevision: context.expectedConsentRevision,
    configuration,
  };
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      revision: state.revision + 1,
      mobile: { ...state.mobile, desired, desiredHistory: history },
    }),
  );
}
