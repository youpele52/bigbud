import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

/** Durable owner route for one application pane; matches the PTY adapter's `terminal:` prefix. */
export const ownedTerminalOwnerRouteKey = (threadId: string, terminalId: string): string =>
  `terminal:${JSON.stringify([threadId, terminalId])}`;

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
