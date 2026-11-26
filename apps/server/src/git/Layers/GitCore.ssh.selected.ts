import { Effect, Layer } from "effect";

import {
  RemoteAgentGitExecutorService,
  type RemoteAgentGitExecutor,
} from "../../remote-agent/remoteAgentGit.ts";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault.ts";
import { readSshOwnerProductionOwner } from "../../ssh/sshOwnerProductionRegistry.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";
import { InitiatingFetchOwner } from "./GitCore.initiatingTransport.ts";
import { readSshTargets } from "./GitCore.fetchRoute.hosts.ts";
import { makeProductionWorkspaceGitOwner } from "./GitCore.ssh.owner.production.ts";
import { GitHubCliOwnerTransport } from "./GitHubCli.owner.ts";
import { makeProductionGitHubCliOwnerTransport } from "./GitHubCli.owner.production.ts";
import { makeProductionInitiatingFetchBinding } from "./GitCore.selectedStream.production.ts";
import { makeProductionPushBinding } from "./GitCore.selectedStream.receive.ts";
import { readSshTargetRecords } from "./GitCore.targetRecords.ts";

/**
 * Git composition for SSH targets: everything runs through the Rust owner.
 *
 * - Direct workspace Git runs the owner's fixed `workspace_git` recipes on the
 *   exact target under the project's root (C06; agent targets keep the
 *   remote-agent executor).
 * - Initiating fetch/pull (U15 upload) and push (U15 receive) use the live
 *   production owner's per-target leases, read on every call, never cached.
 * - `gh pr checkout` picks its transport from the repository's remotes: the
 *   U14 fence, or one U15 upload lease for a single bigbud-target remote.
 */
export function makeSshOwnerGitLayer(agent?: RemoteAgentGitExecutor) {
  const direct = makeSshGitExecutor(makeProductionWorkspaceGitOwner());
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
    makeProductionGitHubCliOwnerTransport({
      ...production,
      targets: () => Effect.runPromise(readSshTargets()),
    }),
  );
  return Layer.mergeAll(git, fetch, github);
}
