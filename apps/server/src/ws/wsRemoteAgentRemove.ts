import { Effect } from "effect";

import { ServerInstallRemoteAgentError } from "@bigbud/contracts/server/server.ts";
import type {
  ServerRemoveRemoteAgentInput,
  ServerRemoveRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteAgentInstall.ts";
import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ServerRemoteAgentRemovalBlocker } from "@bigbud/contracts/server/server.remoteAgentInstall.ts";

import { isRemoteAgentExecutionTarget } from "../remote-agent/remoteAgentDefault.ts";
import { remoteAgentFailureMessage } from "../remote-agent/remoteAgentFailure.ts";
import { boundRemovalBlockers } from "../remote-agent/remoteAgentInstall.remove.blockers.ts";
import type { RemoteAgentInstaller } from "../remote-agent/remoteAgentServerLayer.ts";

export interface RemoveRemoteAgentDependencies {
  readonly remoteAgentInstaller?: RemoteAgentInstaller | undefined;
  /** Drops the durable selected connection so the next agent connect admits fresh. */
  readonly forgetTarget?: (executionTargetId: string) => Promise<void>;
  /** Clears cached update status for the target. */
  readonly forgetUpdateState?: (executionTargetId: string) => void;
  /**
   * Running or mid-turn provider sessions on the target. Checked before anything is closed:
   * removal never stops a chat that is working.
   */
  readonly liveProviderSessionBlockers: (
    executionTargetId: string,
  ) => Effect.Effect<ReadonlyArray<ServerRemoteAgentRemovalBlocker>>;
  /**
   * The Disconnect RPC's teardown without stopping provider sessions; the person reconnects
   * explicitly. Resolves whether the target is now disconnected.
   */
  readonly disconnect: (executionTargetId: string) => Effect.Effect<boolean, Error>;
  readonly switchWorkspacesToDirectSsh: (
    executionTargetId: string,
  ) => Effect.Effect<ReadonlyArray<ProjectId>, Error>;
}

const logStep = (step: string, executionTargetId: string) =>
  Effect.catchCause((cause) =>
    Effect.logWarning("remote agent removal follow-up step failed", {
      step,
      executionTargetId,
      cause,
    }),
  );

/**
 * Settings → Remove agent and `bigbud remote-agent remove`: delete `~/.bigbud/agent` when no
 * live work uses it, then disconnect the host and optionally move its workspaces to Direct SSH.
 * Blocked and failed removals are results; only an unusable request is an error.
 */
export const removeRemoteAgentEffect = Effect.fn("removeRemoteAgentEffect")(function* (
  input: ServerRemoveRemoteAgentInput,
  dependencies: RemoveRemoteAgentDependencies,
): Effect.fn.Return<ServerRemoveRemoteAgentResult, ServerInstallRemoteAgentError> {
  const target = input.executionTargetId;
  if (!isRemoteAgentExecutionTarget(target)) {
    return yield* new ServerInstallRemoteAgentError({
      message: "This remote workspace uses Direct SSH. There is no bigbud remote agent to remove.",
    });
  }
  const remove = dependencies.remoteAgentInstaller?.remove;
  if (!remove) {
    return yield* new ServerInstallRemoteAgentError({
      message: "Remote agent removal is unavailable in this server configuration.",
    });
  }
  const sessionBlockers = yield* dependencies.liveProviderSessionBlockers(target);
  if (sessionBlockers.length > 0)
    return { outcome: "blocked", blockers: boundRemovalBlockers(sessionBlockers) };
  const removal = yield* Effect.tryPromise({
    try: () => remove(target),
    catch: (cause) =>
      new ServerInstallRemoteAgentError({ message: remoteAgentFailureMessage(cause), cause }),
  }).pipe(
    Effect.map((result) => ({ ok: true as const, result })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
  );
  if (!removal.ok) return { outcome: "failed", message: removal.message };
  if (removal.result.outcome === "blocked")
    return { outcome: "blocked", blockers: [...removal.result.blockers] };

  const forgetTarget = dependencies.forgetTarget;
  if (forgetTarget)
    yield* Effect.tryPromise(() => forgetTarget(target)).pipe(logStep("forget-target", target));
  dependencies.forgetUpdateState?.(target);
  const disconnected = yield* dependencies.disconnect(target).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("remote agent removal follow-up step failed", {
        step: "disconnect",
        executionTargetId: target,
        cause,
      }).pipe(Effect.as(false)),
    ),
  );
  const switchedWorkspaceIds =
    input.switchWorkspacesToDirectSsh === false
      ? []
      : yield* dependencies.switchWorkspacesToDirectSsh(target).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("remote agent removal could not switch workspaces", {
              executionTargetId: target,
              cause,
            }).pipe(Effect.as([] as ReadonlyArray<ProjectId>)),
          ),
        );
  return {
    outcome: "removed",
    disconnected: disconnected ? 1 : 0,
    switchedWorkspaceIds: [...switchedWorkspaceIds],
  };
});
