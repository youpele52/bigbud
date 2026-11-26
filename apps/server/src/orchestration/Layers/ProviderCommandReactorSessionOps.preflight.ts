/**
 * SSH readiness pre-flight before a provider session starts.
 *
 * Refuses a session whose SSH target the user disconnected (`assertSshTargetConnected`) for
 * every distinct SSH target the session uses. Authentication, host trust and credential prompts
 * belong to the Rust SSH owner; nothing here launches SSH. The typed SSH error is kept as
 * `cause`, so the turn-start failure classifies as a remote-target failure whatever each adapter
 * would have wrapped it as.
 *
 * @module ProviderCommandReactorSessionOps.preflight
 */
import type { ProviderKind, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { ProviderAdapterProcessError } from "../../provider/Errors.ts";
import type { ProviderSessionExecutionTargets } from "../../provider/providerSessionExecutionTargets.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import { assertSshTargetConnected } from "../../ssh/sshTargetDisconnects.ts";

export function sshTargetsForSession(
  targets: Pick<
    ProviderSessionExecutionTargets,
    "providerRuntimeExecutionTargetId" | "workspaceExecutionTargetId"
  >,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const id of [targets.workspaceExecutionTargetId, targets.providerRuntimeExecutionTargetId]) {
    const target = parseSshExecutionTarget(id);
    if (target) ids.add(target.executionTargetId);
  }
  return [...ids];
}

export const assertSessionSshTargetsReady = Effect.fn("assertSessionSshTargetsReady")(
  function* (input: {
    readonly provider: ProviderKind;
    readonly threadId: ThreadId;
    readonly targets: Pick<
      ProviderSessionExecutionTargets,
      "providerRuntimeExecutionTargetId" | "workspaceExecutionTargetId"
    >;
  }) {
    for (const executionTargetId of sshTargetsForSession(input.targets)) {
      yield* Effect.try({
        try: () => assertSshTargetConnected(executionTargetId),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: input.provider,
            threadId: input.threadId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
    }
  },
);
