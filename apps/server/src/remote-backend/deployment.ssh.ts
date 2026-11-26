import { makeOwnedDeploymentSshRunner, type DeploymentSshOwner } from "./deployment.ssh.owner.ts";
import type { DeploymentRemoteRunner } from "./deployment.types.ts";

export type DeploymentSshTransport = {
  readonly kind: "owner";
  readonly owner: DeploymentSshOwner;
};

/** Every deployment step runs through the owner; an unsupported step cannot fall back. */
export function makeDeploymentSshRunner(transport: DeploymentSshTransport): DeploymentRemoteRunner {
  return makeOwnedDeploymentSshRunner(transport.owner);
}
