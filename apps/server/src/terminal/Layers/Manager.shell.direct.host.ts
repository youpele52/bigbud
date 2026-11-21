/**
 * Spawning Direct SSH panes whose ssh client runs in the local terminal host (plan M7). Before
 * the host can start one, the pane's hosted journal record binds it to its SSH target; a pane
 * never reattaches to another target's session. The record is released when the host confirms
 * the exit, when nothing was started, or when the terminal ran in-process after all. Spawns for
 * every other target go to the adapter unchanged.
 *
 * @module Manager.shell.direct.host
 */
import * as Effect from "effect/Effect";

import { PtySpawnError, type PtyProcess, type PtySpawnInput } from "../Services/PTY";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import {
  hostedDirectShellHost,
  hostedDirectShellOwner,
  type HostedDirectShellOwner,
  type HostedDirectShellOwnerStore,
} from "./DirectShellLaunch.hosted";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle";
import type { TerminalSessionState } from "./Manager.types";
import { ownedTerminalMayBeRetained } from "./OwnedPtyRuntime.owner";
import { resolveOwnedPtyRuntime } from "./OwnedPtyRuntime.resolve";
import { hostedDirectShellState } from "./Manager.shell.direct.settle";

const spawnError = (message: string, cause?: unknown) =>
  new PtySpawnError({
    adapter: "direct-ssh-host",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

function hostedStore(ctx: Pick<ProcessLifecycleContext, "directShellOwners">) {
  const store = ctx.directShellOwners;
  return store?.getHosted && store.reserveHosted && store.releaseHosted
    ? (store as Pick<HostedDirectShellOwnerStore, "getHosted" | "reserveHosted" | "releaseHosted">)
    : undefined;
}

/** Every PTY spawn of the manager; only Direct SSH panes with a host runtime take this path. */
export function spawnTerminalPty(
  ctx: ProcessLifecycleContext,
  session: TerminalSessionState,
  input: PtySpawnInput,
): Effect.Effect<PtyProcess, PtySpawnError> {
  const runtime = resolveOwnedPtyRuntime(ctx.ptyAdapter, session.executionTargetId);
  if (!runtime?.localSshClient || !input.ownerKey) return ctx.ptyAdapter.spawn(input);
  return spawnHostedDirectShell(ctx, session, input);
}

const spawnHostedDirectShell = Effect.fn("terminal.spawnHostedDirectShell")(function* (
  ctx: ProcessLifecycleContext,
  session: TerminalSessionState,
  input: PtySpawnInput,
): Effect.fn.Return<PtyProcess, PtySpawnError> {
  const store = hostedStore(ctx);
  const runtime = resolveOwnedPtyRuntime(ctx.ptyAdapter, session.executionTargetId);
  const { threadId, terminalId, executionTargetId } = session;
  const existing = store
    ? yield* Effect.tryPromise({
        try: () => store.getHosted(directShellOwnerKey(threadId, terminalId)),
        catch: (cause) => spawnError("Could not read this pane's SSH session record.", cause),
      })
    : undefined;
  if (existing && existing.executionTargetId !== executionTargetId) {
    // A record whose session the host proves gone (closed on quit, say) binds nothing.
    const state = yield* hostedDirectShellState(
      {
        directShellOwners: ctx.directShellOwners,
        resolveOwnedRuntime: (target) => resolveOwnedPtyRuntime(ctx.ptyAdapter, target),
      },
      existing,
    );
    if (state.status !== "gone")
      return yield* spawnError(
        `This pane still runs an SSH session on ${hostedDirectShellHost(existing)}. Close it before opening a terminal on another host.`,
      );
    if (store) yield* Effect.promise(() => store.releaseHosted(existing).catch(() => false));
  }
  const current = existing?.executionTargetId === executionTargetId ? existing : undefined;
  const reserve = (): Effect.Effect<HostedDirectShellOwner | undefined, PtySpawnError> => {
    if (!store) return Effect.succeed(undefined);
    const owner = hostedDirectShellOwner({ threadId, terminalId, executionTargetId });
    return Effect.tryPromise({
      try: async () => (await store.reserveHosted(owner)).owner,
      catch: (cause) =>
        spawnError(
          cause instanceof Error ? cause.message : "Could not record this SSH session.",
          cause,
        ),
    });
  };
  const release = (record: HostedDirectShellOwner | undefined): Effect.Effect<void> =>
    record && store
      ? Effect.promise(() => store.releaseHosted(record).catch(() => false)).pipe(Effect.asVoid)
      : Effect.void;
  // Recorded before any dispatch, so a crash after the host started it still names its host.
  const reserved = current || input.recoverOnly ? undefined : yield* reserve();
  const attempt = yield* Effect.result(ctx.ptyAdapter.spawn(input));
  if (attempt._tag === "Failure") {
    // Only a host owner that may still be live keeps the record (its retry reattaches).
    const retained = runtime
      ? yield* ownedTerminalMayBeRetained(runtime, threadId, terminalId)
      : false;
    if (!retained) yield* release(reserved);
    return yield* attempt.failure;
  }
  const process = attempt.success;
  // No host resource: the terminal ran in-process and ends with this backend.
  if (!process.remoteResourceId) {
    yield* release(reserved ?? current);
    return process;
  }
  // A reattached PTY whose record was forgotten gets its binding back.
  const record = reserved ?? current ?? (yield* Effect.orElseSucceed(reserve(), () => undefined));
  if (record && store) {
    const run = Effect.runForkWith(yield* Effect.services<never>());
    process.onExit(() => {
      // An interruption (the host or backend went away) is not an exit: keep the record.
      if (!process.interruptionReason) run(release(record));
    });
  }
  return process;
});
