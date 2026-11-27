import type { PickerProofOwner } from "./sshOwnerPickerProof.client.session.types.ts";
import type { OwnerShutdownReport } from "./sshOwnerPickerProof.codec.ownerShutdown.ts";
import { clearSshOwnerAttachmentDescriptor } from "./sshOwnerProductionClient.attachment.ts";
import { SshOwnerClientError } from "./sshOwnerProductionClient.errors.ts";
import { waitForSshOwnerSocketGone } from "./sshOwnerProductionClient.identity.ts";

/**
 * Drain-time owner shutdown for the production handle (cutover §d1/§d2): the owner
 * closes every master and lease, clears its attach record and exits before the
 * backend lock is released. The backend then confirms the exit (attach socket
 * gone, bounded) and removes any descriptor it still holds, so no later backend,
 * from any install path, can re-attach the drained owner.
 *
 * @module sshOwnerProductionClient.shutdown
 */
export async function shutdownSshOwnerForDrain(input: {
  readonly owner: PickerProofOwner;
  readonly socketPath: string;
  readonly attachFile: string;
  readonly exitWaitMs?: number;
}): Promise<OwnerShutdownReport> {
  if (!input.owner.shutdownOwner) {
    throw new SshOwnerClientError(
      "version-incompatible",
      "The SSH owner has no drain shutdown; it cannot be retired before the upgrade.",
    );
  }
  const report = await input.owner.shutdownOwner();
  const exited = await waitForSshOwnerSocketGone(input.socketPath, input.exitWaitMs);
  await clearSshOwnerAttachmentDescriptor(input.attachFile, input.socketPath).catch(
    () => undefined,
  );
  await input.owner.close().catch(() => undefined);
  if (!exited) {
    throw new SshOwnerClientError(
      "owner-died",
      "The SSH owner reported its shutdown but did not exit within the drain deadline.",
    );
  }
  return report;
}
