import type { BackendInstanceShape } from "../startup/backendInstance.ts";
import type { RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";
import type { withMobilePublicationOwner } from "./mobileGatewayLifecycle.publication.ts";
import { currentMobileGatewayBinding } from "./mobileGatewayLifecycle.binding.ts";
import type { MobileGatewayConfiguration } from "./mobileGatewayLifecycle.schema.ts";
import type { MobileGatewayAdmissionContext } from "./mobileGatewayLifecycle.transitions.ts";
export type MobileGatewayPublicationContext = Parameters<
  Parameters<typeof withMobilePublicationOwner>[1]
>[0];

/** Shared original locked-backend + live canonical P4 admission; does not reserve or launch. */
export async function mobileGatewayAdmissionContext(
  owner: BackendInstanceShape,
  owners: Pick<RemoteAgentOwnerStore, "getBinding">,
  configuration: MobileGatewayConfiguration,
  publication: MobileGatewayPublicationContext,
  signal: AbortSignal,
): Promise<MobileGatewayAdmissionContext> {
  const { authority, paths } = publication;
  if (
    owner.nonce !== authority.owner.nonce ||
    owner.stateDir !== authority.owner.stateDir ||
    owner.lockPath !== authority.owner.lockPath ||
    owner.pid !== authority.owner.pid ||
    owner.startedAt !== authority.owner.startedAt
  )
    throw Error("Gateway lifecycle requires the original locked publication backend.");
  await owner.assertHeld();
  const binding = await currentMobileGatewayBinding(authority, owners, signal);
  await publication.revalidate();
  return {
    owner: paths.owner,
    controller: authority.controller,
    controllerHost: Object.freeze({
      hostname: authority.owner.hostname,
      machineId: authority.owner.machineId,
    }),
    stageId: paths.stageId,
    releaseId: paths.releaseId,
    consentRevision: paths.consentRevision,
    binding,
    configuration,
    now: Date.now(),
  };
}
