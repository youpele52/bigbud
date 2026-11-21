/**
 * Close, delete and forget for Direct SSH panes whose ssh client runs in the local terminal host
 * (plan M7). The host can verify such a PTY, so its hosted record never blocks on its own: a
 * live PTY is closed with terminate and its exit confirmed, a gone one just loses its record.
 * Only an unreachable host (`unknown`) blocks a close or a thread deletion, and Forget is the
 * user's explicit way past that. Detach stays reserved for backend restarts and keep-mode quits.
 *
 * @module Manager.shell.direct.settle
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";

import type { RemoteAgentOwner } from "../../remote-agent/remoteAgentOwners";
import type { OwnedPtyHostedStatus, OwnedPtyLocalSshClient } from "../Services/OwnedPtyRuntime";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { hostedDirectShellHost, type HostedDirectShellOwner } from "./DirectShellLaunch.hosted";
import type { SessionApiContext } from "./Manager.session.types";
import { ownedTerminalOwnerRouteKey } from "./OwnedPtyRuntime.owner";
import { sessionOwnedPtyRuntime } from "./OwnedPtyRuntime.resolve";

type HostedContext = Pick<SessionApiContext, "directShellOwners" | "resolveOwnedRuntime">;
type HostedState =
  | { readonly status: "gone" | "unknown" }
  | {
      readonly status: Exclude<OwnedPtyHostedStatus, "gone">;
      readonly owner: RemoteAgentOwner;
      readonly client: OwnedPtyLocalSshClient;
    };

const failure = (threadId: string, terminalId: string, executionTargetId: string, detail: string) =>
  new TerminalExecutionTargetError({ threadId, terminalId, executionTargetId, detail });

const unreachableDetail = (record: HostedDirectShellOwner) =>
  `The terminal host running the SSH session on ${hostedDirectShellHost(record)} can't be reached, so it couldn't be closed. Nothing was closed; the remote shell may still be running.`;

/** What the host says about one record's PTY. Never throws: unreadable facts are `unknown`. */
export const hostedDirectShellState = Effect.fn("terminal.hostedDirectShellState")(function* (
  ctx: HostedContext,
  record: HostedDirectShellOwner,
) {
  const runtime = sessionOwnedPtyRuntime(ctx, record.executionTargetId);
  const client = runtime?.localSshClient;
  if (!runtime || !client) return { status: "unknown" } as HostedState;
  const { threadId, terminalId } = record.pane;
  const owner = yield* Effect.tryPromise(() =>
    runtime.owners().get(ownedTerminalOwnerRouteKey(threadId, terminalId)),
  ).pipe(Effect.option);
  if (Option.isNone(owner)) return { status: "unknown" } as HostedState;
  const route = owner.value;
  // No live host owner, or one that is not this pane's ssh client: nothing to close for it.
  if (
    !route ||
    route.state === "terminal" ||
    route.target !== runtime.targetId ||
    route.shellLaunch
  )
    return { status: "gone" } as HostedState;
  // A launch still in flight has no verdict yet.
  if (route.state === "prepared") return { status: "unknown" } as HostedState;
  const status = yield* Effect.promise(() =>
    client.status(route).catch((): OwnedPtyHostedStatus => "unknown"),
  );
  return (status === "gone" ? { status } : { status, owner: route, client }) as HostedState;
});

const releaseRecord = (ctx: HostedContext, record: HostedDirectShellOwner) =>
  Effect.promise(async () => (await ctx.directShellOwners?.releaseHosted?.(record)) ?? false);

const stillRecorded = (ctx: HostedContext, record: HostedDirectShellOwner) =>
  Effect.promise(async () => {
    const current = await ctx.directShellOwners?.getHosted?.(record.ownerKey).catch(() => record);
    return current?.reservationId === record.reservationId;
  });

/** Closes a live PTY (confirmed exit), then removes its record; `unknown` fails, nothing changed. */
const settleRecord = Effect.fn("terminal.settleHostedDirectShell")(function* (
  ctx: HostedContext,
  record: HostedDirectShellOwner,
) {
  const { threadId, terminalId } = record.pane;
  const state = yield* hostedDirectShellState(ctx, record);
  if (state.status === "unknown")
    return yield* failure(
      threadId,
      terminalId,
      record.executionTargetId,
      unreachableDetail(record),
    );
  if (state.status === "live")
    yield* Effect.tryPromise({
      try: () => state.client.close(state.owner),
      catch: () =>
        failure(
          threadId,
          terminalId,
          record.executionTargetId,
          `The SSH session on ${hostedDirectShellHost(record)} didn't confirm that it ended. Its record was kept; the remote shell may still be running.`,
        ),
    });
  yield* releaseRecord(ctx, record);
});

/** One pane's close (the existing close path): settles its hosted record, if it has one. */
export const settleHostedDirectShellPane = Effect.fn("terminal.settleHostedDirectShellPane")(
  function* (ctx: HostedContext, threadId: string, terminalId: string) {
    const getHosted = ctx.directShellOwners?.getHosted;
    if (!getHosted) return;
    const record = yield* Effect.tryPromise({
      try: () => getHosted(directShellOwnerKey(threadId, terminalId)),
      catch: () =>
        failure(threadId, terminalId, "unknown", "Could not read this pane's SSH session record."),
    });
    if (record) yield* settleRecord(ctx, record);
  },
);

export const listHostedDirectShells = Effect.fn("terminal.listHostedDirectShells")(function* (
  ctx: HostedContext,
  threadId: string,
) {
  const list = ctx.directShellOwners?.listHostedForThread;
  if (!list) return [] as ReadonlyArray<HostedDirectShellOwner>;
  return yield* Effect.tryPromise({
    try: () => list(threadId),
    catch: () =>
      failure(threadId, "unknown", "unknown", "Could not read this thread's SSH session records."),
  });
});

/**
 * Before a thread-wide close closes anything: every hosted pane no live session will close must
 * be verifiable. Returns the records, whose panes the caller closes like any other.
 */
export const assertHostedDirectShellsReachable = Effect.fn(
  "terminal.assertHostedDirectShellsReachable",
)(function* (ctx: HostedContext, threadId: string, livePanes: ReadonlySet<string>) {
  const records = yield* listHostedDirectShells(ctx, threadId);
  for (const record of records) {
    if (livePanes.has(record.pane.terminalId)) continue;
    const state = yield* hostedDirectShellState(ctx, record);
    if (state.status === "unknown")
      return yield* failure(
        threadId,
        record.pane.terminalId,
        record.executionTargetId,
        unreachableDetail(record),
      );
  }
  return records;
});

/** Records the user would be asked to forget: those the host cannot prove gone. */
export const retainedHostedDirectShells = Effect.fn("terminal.retainedHostedDirectShells")(
  function* (ctx: HostedContext, threadId: string) {
    const retained: HostedDirectShellOwner[] = [];
    for (const record of yield* listHostedDirectShells(ctx, threadId))
      if ((yield* hostedDirectShellState(ctx, record)).status !== "gone") retained.push(record);
    return retained;
  },
);

/**
 * Explicit Forget: a PTY the host reports live is closed with terminate first; then every record
 * is removed, including those an unreachable host cannot verify (the user's decision).
 */
export const forgetHostedDirectShells = Effect.fn("terminal.forgetHostedDirectShells")(function* (
  ctx: HostedContext,
  threadId: string,
) {
  let forgotten = 0;
  for (const record of yield* listHostedDirectShells(ctx, threadId)) {
    const state = yield* hostedDirectShellState(ctx, record);
    if (state.status === "live") {
      const closed = yield* Effect.promise(() =>
        state.client.close(state.owner).then(
          () => true,
          () => false,
        ),
      );
      if (!closed)
        yield* Effect.logWarning("forgot an SSH session record whose close was unconfirmed", {
          threadId,
          terminalId: record.pane.terminalId,
        });
    }
    // The pane's own exit may have released it first; either way it is forgotten.
    if ((yield* releaseRecord(ctx, record)) || !(yield* stillRecorded(ctx, record))) forgotten += 1;
  }
  return forgotten;
});
