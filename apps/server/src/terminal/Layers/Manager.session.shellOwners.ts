/**
 * Thread-scoped view of the durable direct-shell owner journal: which panes belong to a thread,
 * which retained owners block its bulk cleanup, and the explicit "forget" recovery for owners
 * whose remote shell can never be verified. Direct SSH panes in the local terminal host (M7) are
 * listed only while the host cannot prove them gone, and Forget closes a live one first.
 *
 * @module Manager.session.shellOwners
 */
import * as Effect from "effect/Effect";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget";
import { directShellOwnerKey, type DirectShellLaunchOwner } from "./DirectShellLaunch.owner";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types";
import { hostedDirectShellHost } from "./DirectShellLaunch.hosted";
import {
  forgetHostedDirectShells,
  retainedHostedDirectShells,
} from "./Manager.shell.direct.settle";

/** Live panes plus panes with retained history; `"unknown"` when history cannot be listed. */
export const knownThreadTerminalIds = Effect.fn("terminal.knownThreadTerminalIds")(function* (
  ctx: Pick<SessionApiContext, "sessionsForThread" | "historyTerminalIdsForThread">,
  threadId: string,
) {
  const sessions = yield* ctx.sessionsForThread(threadId);
  const historyTerminalIds = yield* ctx.historyTerminalIdsForThread(threadId);
  return historyTerminalIds === "unknown"
    ? ("unknown" as const)
    : [...sessions.map((session) => session.terminalId), ...historyTerminalIds];
});

export function threadPaneKeyMatcher(
  threadId: string,
  terminalIds: ReadonlyArray<string>,
): (ownerKey: string) => boolean {
  const keys = new Set(terminalIds.map((terminalId) => directShellOwnerKey(threadId, terminalId)));
  return (ownerKey) => keys.has(ownerKey);
}

/** The host a person recognises for an owner's shell, e.g. the SSH host name. */
export function directShellOwnerHost(owner: DirectShellLaunchOwner): string {
  const { executionTargetId, wslIdentity } = owner.intent;
  if (wslIdentity) return `WSL ${wslIdentity.distribution}`;
  return parseSshExecutionTarget(executionTargetId)?.host ?? executionTargetId;
}

export function makeRetainedShellOwnerApi(
  ctx: SessionApiContext,
): Required<Pick<TerminalManagerShape, "retainedShellOwners" | "forgetRetainedShellOwners">> {
  const unavailable = (threadId: string, detail: string) =>
    new TerminalExecutionTargetError({
      threadId,
      terminalId: "unknown",
      executionTargetId: "unknown",
      detail,
    });
  const resolveMatcher = Effect.fn("terminal.resolveThreadPaneKeyMatcher")(function* (
    threadId: string,
  ) {
    const terminalIds = yield* knownThreadTerminalIds(ctx, threadId);
    if (terminalIds === "unknown") {
      return yield* unavailable(
        threadId,
        "Could not list this thread's terminals, so its remote shell records were left unchanged.",
      );
    }
    return threadPaneKeyMatcher(threadId, terminalIds);
  });
  const store = ctx.directShellOwners;
  return {
    retainedShellOwners: (input) =>
      Effect.gen(function* () {
        if (!store?.listForThread) return { hosts: [], count: 0 };
        const matcher = yield* resolveMatcher(input.threadId);
        const owners = yield* Effect.tryPromise({
          try: () => store.listForThread!(input.threadId, matcher),
          catch: () => unavailable(input.threadId, "Could not read remote shell records."),
        });
        // Direct SSH panes in the local host (M7) that the host cannot prove gone.
        const hosted = yield* retainedHostedDirectShells(ctx, input.threadId);
        const hosts = [...owners.map(directShellOwnerHost), ...hosted.map(hostedDirectShellHost)];
        return { hosts: [...new Set(hosts)], count: owners.length + hosted.length };
      }),
    forgetRetainedShellOwners: (input) =>
      ctx.withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (!store?.forgetForThread) {
            return yield* unavailable(
              input.threadId,
              "This bigbud server cannot forget remote shell records.",
            );
          }
          const matcher = yield* resolveMatcher(input.threadId);
          const legacy = yield* Effect.tryPromise({
            try: () => store.forgetForThread!(input.threadId, matcher),
            catch: () => unavailable(input.threadId, "Could not forget remote shell records."),
          });
          // A hosted SSH session the host reports live is closed before its record goes.
          const forgotten = legacy + (yield* forgetHostedDirectShells(ctx, input.threadId));
          yield* Effect.logWarning("forgot unverifiable direct shell records at user request", {
            threadId: input.threadId,
            forgotten,
          });
          return { forgotten };
        }),
      ),
  };
}
