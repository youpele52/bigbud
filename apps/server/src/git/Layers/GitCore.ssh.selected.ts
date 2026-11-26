import { Layer } from "effect";

import {
  RemoteAgentGitExecutorService,
  type RemoteAgentGitExecutor,
} from "../../remote-agent/remoteAgentGit.ts";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault.ts";
import { readSshOwnerProductionOwner } from "../../ssh/sshOwnerProductionRegistry.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";
import { InitiatingFetchOwner } from "./GitCore.initiatingTransport.ts";
import { makeSelectedGitHubCliOwnerTransport } from "./GitCore.selectedStream.ts";
import { GitHubCliOwnerTransport } from "./GitHubCli.owner.ts";
import { makeProductionInitiatingFetchBinding } from "./GitCore.selectedStream.production.ts";
import { makeProductionPushBinding } from "./GitCore.selectedStream.receive.ts";
import { readSshTargetRecords } from "./GitCore.targetRecords.ts";

/**
 * Git composition for SSH targets: everything runs through the Rust owner.
 *
 * - Direct workspace Git refuses typed until the owner serves it (agent
 *   targets keep the remote-agent executor).
 * - Initiating fetch/pull (U15 upload) and push (U15 receive) use the live
 *   production owner's per-target leases, read on every call, never cached.
 * - `gh` traffic to a bigbud target has no owner stream and refuses typed.
 */
export function makeSshOwnerGitLayer(agent?: RemoteAgentGitExecutor) {
  const direct = makeSshGitExecutor();
  const git = Layer.succeed(RemoteAgentGitExecutorService, (input) =>
    agent && isRemoteAgentExecutionTarget(input.executionTargetId) ? agent(input) : direct(input),
  );
  const production = { owner: readSshOwnerProductionOwner, records: readSshTargetRecords };
  const fetch = Layer.succeed(InitiatingFetchOwner, {
    ...makeProductionInitiatingFetchBinding(production),
    push: makeProductionPushBinding(production),
  });
  const github = Layer.succeed(
    GitHubCliOwnerTransport,
    makeSelectedGitHubCliOwnerTransport({ session: undefined }),
  );
  return Layer.mergeAll(git, fetch, github);
}
