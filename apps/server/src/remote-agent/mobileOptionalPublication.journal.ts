import {
  verifyRemoteAgentMobileStageBytes,
  type MobileStageContext,
} from "./remoteAgentInstall.mobile.transitions.ts";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import type {
  MobilePublicationIntent,
  MobilePublicationReceipt,
} from "./mobileOptionalPublication.schema.ts";

export interface MobilePublicationCompletion {
  readonly id: string;
  readonly releaseId: string;
  readonly gatewayBytes: Uint8Array;
  readonly assetsBytes: Uint8Array;
}
export function requireCurrentMobilePublicationStage(
  state: RemoteAgentRegistry,
  context: MobileStageContext,
  id: string,
) {
  const stage = state.schemaVersion === 3 && state.mobile.stages.find((entry) => entry.id === id);
  if (
    !stage ||
    stage.phase === "cancelled" ||
    stage.consentRevision !== context.expectedConsentRevision ||
    stage.controller.id !== context.controller.id ||
    stage.controller.pid !== context.controller.pid ||
    stage.controller.startedAt !== context.controller.startedAt ||
    JSON.stringify(stage.controllerHost) !== JSON.stringify(context.controllerHost)
  )
    throw new Error("Mobile publication stage owner changed or was cancelled.");
  return stage;
}
function checked(
  state: RemoteAgentRegistry,
  context: MobileStageContext,
  request: MobilePublicationCompletion,
) {
  const verified = verifyRemoteAgentMobileStageBytes(state, context, request);
  if (verified.schemaVersion !== 3) throw new Error("Mobile publication requires the v3 journal.");
  const stage = verified.mobile.stages.find((entry) => entry.id === request.id)!;
  return { state: verified, stage };
}

/** Journal DATA only; physical publication and opaque proof creation stay in the owned publisher. */
export function recordMobilePublicationIntent(
  state: RemoteAgentRegistry,
  context: MobileStageContext,
  request: MobilePublicationCompletion,
  intent: MobilePublicationIntent,
): RemoteAgentRegistry {
  const verified = checked(state, context, request);
  if (verified.stage.publicationIntent) {
    if (JSON.stringify(verified.stage.publicationIntent) !== JSON.stringify(intent))
      throw new Error("Mobile publication directory identity changed.");
    return verified.state;
  }
  // checked may have verified bytes in memory; one CAS must still advance exactly once.
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...verified.state,
      revision: state.revision + 1,
      mobile: {
        ...verified.state.mobile,
        stages: verified.state.mobile.stages.map((entry) =>
          entry.id === request.id
            ? Object.assign({}, entry, { phase: "publication-writing", publicationIntent: intent })
            : entry,
        ),
      },
    }),
  );
}

export function recordMobilePublicationReceipt(
  state: RemoteAgentRegistry,
  context: MobileStageContext,
  request: MobilePublicationCompletion,
  intent: MobilePublicationIntent,
  receipt: MobilePublicationReceipt,
): RemoteAgentRegistry {
  const verified = checked(state, context, request);
  if (
    !verified.stage.publicationIntent ||
    JSON.stringify(verified.stage.publicationIntent) !== JSON.stringify(intent)
  ) {
    throw new Error("Mobile publication intent is missing or changed.");
  }
  if (verified.stage.publicationReceipt) {
    if (JSON.stringify(verified.stage.publicationReceipt) !== JSON.stringify(receipt))
      throw new Error("Mobile publication receipt is immutable.");
    return verified.state;
  }
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...verified.state,
      revision: state.revision + 1,
      mobile: {
        ...verified.state.mobile,
        stages: verified.state.mobile.stages.map((entry) =>
          entry.id === request.id
            ? Object.assign({}, entry, { phase: "files-published", publicationReceipt: receipt })
            : entry,
        ),
      },
    }),
  );
}
