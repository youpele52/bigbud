import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.ts";
import type { PickerProofOwner } from "./sshOwnerPickerProof.client.session.types.ts";
import { SshOwnerClientError } from "./sshOwnerProductionClient.errors.ts";
import {
  attachSshOwnerProduction,
  classifyStartupError,
  type SshOwnerAttachmentDescriptor,
} from "./sshOwnerProductionClient.launch.ts";
import type { StartSshOwnerProductionInput } from "./sshOwnerProductionClient.ts";

/**
 * Attach to the profile's live owner, never spawning. `undefined` means no listener
 * (the descriptor is stale, so the caller may spawn); `"artifact-mismatch"` means the
 * owner belongs to another install path or build, refused typed and retires itself.
 *
 * @module sshOwnerProductionClient.reattach
 */
const clientError = (failure: SshOwnerClientError["failure"], message: string, cause?: unknown) =>
  new SshOwnerClientError(failure, message, cause);

export async function tryAttachSshOwnerProduction(
  input: Pick<StartSshOwnerProductionInput, "facts" | "sql">,
  descriptor: SshOwnerAttachmentDescriptor,
  expectedArtifactIdentity: Uint8Array,
): Promise<PickerProofOwner | undefined | "artifact-mismatch"> {
  try {
    return await attachSshOwnerProduction({
      expectedArtifactIdentity,
      profileBinding: input.facts.profileBinding,
      profileScope: input.facts.stateDirectory,
      ...(input.facts.target === undefined ? {} : { targetId: input.facts.target.targetId }),
      sql: input.sql,
      descriptor,
    });
  } catch (cause) {
    const code = cause instanceof PickerProofOwnerError ? cause.code : "";
    // No listener: the descriptor is stale. Only then may this backend spawn.
    if (code === "ownerUnavailable") return undefined;
    // Another install path or build: the owner refused typed and retires itself.
    if (code === "ownerArtifactMismatch") return "artifact-mismatch";
    if (code === "profileMismatch") {
      throw clientError(
        "profile-mismatch",
        "The live SSH owner reported a different profile binding; refusing the attachment.",
        cause,
      );
    }
    if (code === "operationDenied") {
      throw clientError(
        "attachment-refused",
        "A live SSH owner refused this profile's attachment capability; refusing to spawn a second owner.",
        cause,
      );
    }
    if (code === "invalidOperands") {
      throw clientError(
        "attachment-invalid",
        "The SSH owner attachment endpoint failed its private-path checks.",
        cause,
      );
    }
    throw classifyStartupError(cause);
  }
}
