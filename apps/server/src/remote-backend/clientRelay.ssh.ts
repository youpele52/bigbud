import { isAbsolute } from "node:path";
import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import { SshOwnerRequiredError } from "../ssh/sshOwnerRequired.ts";
import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";

import {
  makeOwnedClientRelaySshChannels,
  type ClientRelayDeployment,
  type ClientRelayOwnerRequest,
  type ClientRelaySshOwner,
} from "./clientRelay.ssh.owner.ts";

export type { ClientRelayDeployment } from "./clientRelay.ssh.owner.ts";

function validateDeployment(deployment: ClientRelayDeployment) {
  if (!/^[a-f0-9]{32}$/.test(deployment.authorityId)) throw new Error("Invalid backend authority.");
  for (const [path, digest] of [
    [deployment.nodeBinary, deployment.nodeSha256],
    [deployment.helperEntry, deployment.helperSha256],
  ]) {
    if (
      !path ||
      !isAbsolute(path) ||
      hasLocalSupervisorServiceControls(path) ||
      !/^[a-f0-9]{64}$/.test(digest ?? "")
    )
      throw new Error("Invalid verified relay deployment.");
  }
}

/** Private local-backend owner. Call only with an admitted SSH target and verified installed graph.
 * No renderer commands, endpoints, real remote credentials or password/session duplication. */
export function makeClientRelaySshChannels(
  input: ClientRelayOwnerRequest & { readonly sshOwner?: ClientRelaySshOwner },
) {
  const { nodeBinary, nodeSha256, helperEntry, helperSha256, authorityId } = input.deployment;
  const deployment = Object.freeze({
    nodeBinary,
    nodeSha256,
    helperEntry,
    helperSha256,
    authorityId,
  });
  validateDeployment(deployment);
  if (input.sshOwner !== undefined) {
    const { executionTargetId } = input;
    if (parseSshExecutionTarget(executionTargetId)?.executionTargetId !== executionTargetId)
      throw new Error("Invalid backend relay SSH target.");
    return makeOwnedClientRelaySshChannels(
      Object.freeze({ executionTargetId, deployment }),
      input.sshOwner,
    );
  }
  // Without an owner relay lease the channel is refused before the profile can publish a
  // loopback lease; there is no TypeScript `ssh` child.
  throw new SshOwnerRequiredError();
}
