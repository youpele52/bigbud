import { Layer } from "effect";

import { makeSshShellRunner } from "../ssh/sshShellRunner.ts";
import { isRemoteAgentExecutionTarget } from "./remoteAgentDefault.ts";
import { RemoteAgentShellRunner, type RemoteAgentShellRunnerResolver } from "./remoteAgentShell.ts";

/**
 * Direct-SSH targets run through the Rust owner's exec lease; agent targets
 * keep the remote-agent resolver. There is no legacy SSH fallback.
 */
export function makeShellRunnerLayer(agentResolver?: RemoteAgentShellRunnerResolver) {
  return Layer.succeed(RemoteAgentShellRunner, {
    resolve: (executionTargetId: string) =>
      agentResolver && isRemoteAgentExecutionTarget(executionTargetId)
        ? agentResolver.resolve(executionTargetId)
        : makeSshShellRunner(executionTargetId),
  });
}
