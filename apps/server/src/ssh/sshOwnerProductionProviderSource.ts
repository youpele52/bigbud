import type { PickerProofProductionProviderClient } from "./sshOwnerPickerProof.client.productionProvider.ts";
import {
  readSshOwnerProductionOwner,
  type SshOwnerProductionRegistration,
} from "./sshOwnerProductionRegistry.ts";
import { descriptorServesTarget } from "./sshOwnerProductionTargets.ts";

/**
 * W2 T-prov production source for the Pi and Codex owner ports: the live registered owner,
 * bound to the exact runtime target through its resolved descriptor. Read per acquisition, so a
 * later owner death is never served from a stale handle (the OpenCode v2 source rule).
 *
 * @module sshOwnerProductionProviderSource
 */

export interface ProductionProviderSourceOptions {
  /** Test-only override of the live production owner registry. */
  readonly production?: () => SshOwnerProductionRegistration | undefined;
}

/**
 * The bound provider client for one runtime target, or `undefined` when no owner is live. A descriptor refusal propagates as its typed error; a descriptor
 * for a different target is never used.
 */
export async function bindProductionProviderTarget(
  targetId: string,
  options: ProductionProviderSourceOptions = {},
): Promise<PickerProofProductionProviderClient | undefined> {
  const live = (options.production ?? readSshOwnerProductionOwner)();
  if (!live) return undefined;
  const descriptor = await live.descriptorFor(targetId);
  if (!descriptorServesTarget(descriptor, targetId)) return undefined;
  return live.handle.target(descriptor);
}
