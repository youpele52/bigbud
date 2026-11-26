import { Effect, Layer, Option } from "effect";

import { makeSshShellRunner } from "../ssh/sshShellRunner.ts";
import type { DevSshOwnerRuntime } from "../ssh/sshOwnerDevRuntime.ts";
import { DevSshOwnerRuntime as DevSshOwnerRuntimeService } from "../ssh/sshOwnerDevRuntime.ts";
import { isRemoteAgentExecutionTarget } from "./remoteAgentDefault.ts";
import { RemoteAgentShellRunner, type RemoteAgentShellRunnerResolver } from "./remoteAgentShell.ts";
import { resolveSelectedShellAccess } from "./remoteAgentShell.selected.ts";

/**
 * The selected direct-SSH target resolves the exact owner session; agent
 * targets keep the remote-agent resolver. Missing authority refuses rather
 * than falling back to legacy SSH.
 */
export function makeShellRunnerLayer<E = never, R = never>(
  devOwner?: Layer.Layer<DevSshOwnerRuntime, E, R>,
  agentResolver?: RemoteAgentShellRunnerResolver,
) {
  const layer = Layer.effect(
    RemoteAgentShellRunner,
    Effect.map(Effect.serviceOption(DevSshOwnerRuntimeService), (runtime) => {
      const access = resolveSelectedShellAccess(Option.getOrUndefined(runtime)?.session);
      return {
        resolve: (executionTargetId: string) =>
          agentResolver && isRemoteAgentExecutionTarget(executionTargetId)
            ? agentResolver.resolve(executionTargetId)
            : makeSshShellRunner(
                executionTargetId,
                access?.targetId === executionTargetId ? access : undefined,
              ),
      };
    }),
  );
  return devOwner ? layer.pipe(Layer.provide(devOwner)) : layer;
}
