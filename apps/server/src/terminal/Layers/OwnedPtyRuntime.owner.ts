import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { NATIVE_SSH_CONNECTION_PREFIX } from "../../terminal-host/localTerminalHost.directSsh.owner.lifecycle.ts";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

/** Durable owner route for one application pane; matches the PTY adapter's `terminal:` prefix. */
export const ownedTerminalOwnerRouteKey = (threadId: string, terminalId: string): string =>
  `terminal:${JSON.stringify([threadId, terminalId])}`;

/** A boot-bound root and durable native lease allow attach-only without a new SSH cwd probe. */
export const findNativeTerminalRecovery = Effect.fn("terminal.findNativeTerminalRecovery")(
  function* (
    runtime: OwnedPtyRuntime | undefined,
    request: { threadId: string; cwd: string },
    terminalId: string,
  ) {
    if (
      !runtime?.localSshClient ||
      (runtime.nativeSshWorkspaceRoot !== request.cwd && !runtime.nativeSshProduction)
    )
      return undefined;
    const key = ownedTerminalOwnerRouteKey(request.threadId, terminalId);
    const route = yield* Effect.tryPromise(() => runtime.owners().get(key));
    return route?.ownerKey === key &&
      route.target === runtime.targetId &&
      route.terminalCwd === request.cwd &&
      route.connectionId.startsWith(NATIVE_SSH_CONNECTION_PREFIX) &&
      !route.shellLaunch &&
      route.state === "may-have-been-sent" &&
      route.resourceId
      ? route
      : undefined;
  },
);

/** A native owner-loss tombstone is not an exit or permission to launch. */
export const findNativeTerminalHostLoss = Effect.fn("terminal.findNativeTerminalHostLoss")(
  function* (runtime: OwnedPtyRuntime | undefined, threadId: string, terminalId: string) {
    const client = runtime?.localSshClient;
    if (!runtime || !client?.isHostLost) return undefined;
    const row = yield* Effect.tryPromise(() =>
      runtime.owners().get(ownedTerminalOwnerRouteKey(threadId, terminalId)),
    ).pipe(Effect.option);
    const route = Option.getOrUndefined(row);
    return route?.target === runtime.targetId && client.isHostLost(route) ? route : undefined;
  },
);

/**
 * Owners are reserved durably before any PTY dispatch and are only removed once
 * proven never-dispatched or terminal. So a missing or `terminal` route proves
 * this runtime holds no live process for the pane: retained local history then
 * came from a non-owned launch (for example plain SSH before the agent transport)
 * or an exited process. An unreadable store is never proof, so it stays retained.
 */
export const ownedTerminalMayBeRetained = Effect.fn("terminal.ownedTerminalMayBeRetained")(
  function* (runtime: OwnedPtyRuntime, threadId: string, terminalId: string) {
    const owner = yield* Effect.tryPromise(() =>
      runtime.owners().get(ownedTerminalOwnerRouteKey(threadId, terminalId)),
    ).pipe(Effect.option);
    return Option.match(owner, {
      onNone: () => true,
      onSome: (route) => route !== undefined && route.state !== "terminal",
    });
  },
);

/**
 * Open/restart reattach-only only when a recovery marker (retained history or a
 * failed recovery) is backed by a durable owner that may still be live.
 */
export const resolveOwnedTerminalRecoverOnly = Effect.fn(
  "terminal.resolveOwnedTerminalRecoverOnly",
)(function* (input: {
  readonly runtime: OwnedPtyRuntime | undefined;
  readonly threadId: string;
  readonly terminalId: string;
  readonly existing: Option.Option<TerminalSessionState>;
  readonly historyExists: (threadId: string, terminalId: string) => Effect.Effect<boolean>;
}) {
  if (!input.runtime) return false;
  const marked = Option.isSome(input.existing)
    ? input.existing.value.remoteOwnerRecoveryRequired === true
    : yield* input.historyExists(input.threadId, input.terminalId);
  return (
    marked && (yield* ownedTerminalMayBeRetained(input.runtime, input.threadId, input.terminalId))
  );
});
