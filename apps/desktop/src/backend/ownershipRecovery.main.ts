import { backendProcess, startBackend } from "./backendManager";
import { createOwnershipRecovery } from "./ownershipRecovery";
import { getOwnershipLaunch } from "./ownershipRecovery.launch";
import { getBackendStartupState, recordOwnershipRecovery } from "./backendStartupState";
import { isInstalledProcessQuiescing } from "./installedProcessQuiescence";
import { isOwnershipHandedOff } from "./ownershipHandoff";

export function makeMainOwnershipRecovery(getIsQuitting: () => boolean) {
  return createOwnershipRecovery({
    state: getBackendStartupState,
    launch: getOwnershipLaunch,
    blocked: () => getIsQuitting() || isInstalledProcessQuiescing() || isOwnershipHandedOff(),
    childPresent: () => backendProcess !== null,
    start: startBackend,
    publish: recordOwnershipRecovery,
  });
}
