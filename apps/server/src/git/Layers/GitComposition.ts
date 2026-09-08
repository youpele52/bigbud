import { Effect, Layer } from "effect";

import { ProjectSetupScriptRunnerLive } from "../../project/Layers/ProjectSetupScriptRunner.ts";
import { RemoteAgentGitExecutorService } from "../../remote-agent/remoteAgentGit.ts";
import { GitCore } from "../Services/GitCore.ts";
import { makeGitCore } from "./GitCore.ts";
import { GitHubCliLive } from "./GitHubCli.ts";
import { GitManagerLive } from "./GitManager.ts";
import { GitStatusBroadcasterLive } from "./GitStatusBroadcaster.ts";
import { RemoteGitStatusInvalidationLive } from "./RemoteGitStatusInvalidation.ts";
import { RoutingTextGenerationLive } from "./RoutingTextGeneration.ts";

export function makeGitCoreLayerLive(remoteAgentLayer: Layer.Layer<RemoteAgentGitExecutorService>) {
  const gitCoreWithRemoteExecutor = Layer.effect(
    GitCore,
    Effect.gen(function* () {
      const remoteExecutor = yield* RemoteAgentGitExecutorService;
      return yield* makeGitCore({ remoteExecuteOverride: remoteExecutor });
    }),
  );
  return gitCoreWithRemoteExecutor.pipe(Layer.provide(remoteAgentLayer));
}

export function makeGitLayerLive(remoteAgentLayer: Layer.Layer<RemoteAgentGitExecutorService>) {
  const gitCoreLive = makeGitCoreLayerLive(remoteAgentLayer);
  return Layer.empty.pipe(
    Layer.provideMerge(RemoteGitStatusInvalidationLive),
    Layer.provideMerge(
      GitManagerLive.pipe(
        Layer.provideMerge(ProjectSetupScriptRunnerLive),
        Layer.provideMerge(gitCoreLive),
        Layer.provideMerge(GitHubCliLive),
        Layer.provideMerge(RoutingTextGenerationLive),
      ),
    ),
    Layer.provideMerge(GitStatusBroadcasterLive.pipe(Layer.provideMerge(gitCoreLive))),
    Layer.provideMerge(gitCoreLive),
  );
}
