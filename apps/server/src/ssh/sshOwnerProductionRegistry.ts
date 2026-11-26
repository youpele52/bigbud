import type { SshOwnerProductionHandle } from "./sshOwnerProductionClient.ts";
import type { SshOwnerTargetDescriptor } from "./sshOwnerProductionClient.launch.ts";

/**
 * The one live production owner, published only after the W3.7 boot sequence
 * opened admission and withdrawn on owner death or shutdown.
 *
 * Inert while `SSH_OWNER_PRODUCTION_ACTIVATION` is off: only
 * `SshOwnerProductionBootLive` registers, and it returns before booting when the
 * constant is off. Consumers read it per acquisition so a later owner death is
 * never served from a stale handle.
 *
 * @module sshOwnerProductionRegistry
 */
export interface SshOwnerProductionRegistration {
  readonly handle: Pick<
    SshOwnerProductionHandle,
    "target" | "ownerEpoch" | "opencodeV2Service" | "opencodeV2Refusal" | "state"
  >;
  /**
   * Exact descriptor for a runtime target (`resolveProductionTargetDescriptor`
   * in production). Rejects with a typed `SshOwnerTargetRefusal` when the
   * target cannot be resolved; it never returns a partial descriptor.
   */
  readonly descriptorFor: (targetId: string) => Promise<SshOwnerTargetDescriptor>;
}

let current: SshOwnerProductionRegistration | undefined;

export function registerSshOwnerProductionOwner(
  registration: SshOwnerProductionRegistration,
): () => void {
  current = registration;
  return () => {
    if (current === registration) current = undefined;
  };
}

/** The live owner, or `undefined` when none is open or it is no longer open. */
export function readSshOwnerProductionOwner(): SshOwnerProductionRegistration | undefined {
  return current?.handle.state() === "open" ? current : undefined;
}

/** Test-only reset. */
export function resetSshOwnerProductionOwnerForTest(): void {
  current = undefined;
}
