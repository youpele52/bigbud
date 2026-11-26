/**
 * Host panes no session holds (plan §14, N8, D1). After a backend restart in keep mode the local
 * terminal host still runs terminals that no view has reopened; they are in the host roster but
 * not in the manager. Closing such a pane, or deleting or archiving its thread, ends it through
 * the host: terminate, then a confirmed exit, exactly like a hosted Direct SSH pane. Only an
 * unreachable host blocks, and then nothing is closed. Without host PTY controls (the flag off,
 * an older runtime) nothing changes.
 *
 * @module Manager.session.close.hostRoster
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";

import type { RemoteAgentOwner } from "../../remote-agent/remoteAgentOwners";
import type { OwnedPtyHostedStatus, OwnedPtyLocalSshClient } from "../Services/OwnedPtyRuntime";
import type { SessionApiContext } from "./Manager.session.types";
import { ownedTerminalOwnerRouteKey } from "./OwnedPtyRuntime.owner";

type RosterContext = Pick<SessionApiContext, "hostLimit">;
type RosterPaneState =
  | { readonly status: "gone" | "unknown" | "unsupported" }
  | {
      readonly status: "live";
      readonly owner: RemoteAgentOwner;
      readonly client: OwnedPtyLocalSshClient;
    };

const failure = (threadId: string, terminalId: string, detail: string) =>
  new TerminalExecutionTargetError({ threadId, terminalId, executionTargetId: "local", detail });

const UNREACHABLE =
  "The terminal service can't be reached, so this terminal couldn't be closed. Nothing was closed; it may still be running.";

const listed = (ctx: RosterContext, threadId: string, terminalId: string) =>
  ctx.hostLimit
    ?.roster()
    .some(
      (entry) => !entry.lost && entry.threadId === threadId && entry.terminalId === terminalId,
    ) === true;

/** The thread's live roster panes that no live session holds. */
export function hostRosterPanesForThread(
  ctx: RosterContext,
  threadId: string,
  held: ReadonlySet<string>,
): ReadonlyArray<string> {
  const panes = new Set<string>();
  for (const entry of ctx.hostLimit?.roster() ?? [])
    if (!entry.lost && entry.threadId === threadId && !held.has(entry.terminalId))
      panes.add(entry.terminalId);
  return [...panes];
}

/** What the host says about one pane's PTY. Never throws: unreadable facts are `unknown`. */
const hostRosterPaneState = Effect.fn("terminal.hostRosterPaneState")(function* (
  ctx: RosterContext,
  threadId: string,
  terminalId: string,
) {
  const runtime = ctx.hostLimit?.runtime;
  const client = runtime?.hostPtys;
  if (!runtime || !client) return { status: "unsupported" } as RosterPaneState;
  const owner = yield* Effect.tryPromise(() =>
    runtime.owners().get(ownedTerminalOwnerRouteKey(threadId, terminalId)),
  ).pipe(Effect.option);
  if (Option.isNone(owner)) return { status: "unknown" } as RosterPaneState;
  const route = owner.value;
  if (!route || route.state === "terminal" || route.target !== runtime.targetId)
    return { status: "gone" } as RosterPaneState;
  if (route.state === "prepared") return { status: "unknown" } as RosterPaneState;
  const status = yield* Effect.promise(() =>
    client.status(route).catch((): OwnedPtyHostedStatus => "unknown"),
  );
  return (status === "live" ? { status, owner: route, client } : { status }) as RosterPaneState;
});

/** Before a thread-wide close closes anything: every roster pane must be verifiable. */
export const assertHostRosterPanesReachable = Effect.fn("terminal.assertHostRosterPanesReachable")(
  function* (ctx: RosterContext, threadId: string, terminalIds: ReadonlyArray<string>) {
    for (const terminalId of terminalIds)
      if ((yield* hostRosterPaneState(ctx, threadId, terminalId)).status === "unknown")
        return yield* failure(threadId, terminalId, UNREACHABLE);
  },
);

/** Closes a roster pane's live host PTY (confirmed exit); a gone one needs nothing. */
export const settleHostRosterPane = Effect.fn("terminal.settleHostRosterPane")(function* (
  ctx: RosterContext,
  threadId: string,
  terminalId: string,
) {
  if (!listed(ctx, threadId, terminalId)) return;
  const state = yield* hostRosterPaneState(ctx, threadId, terminalId);
  if (state.status === "unknown") return yield* failure(threadId, terminalId, UNREACHABLE);
  if (state.status === "live")
    yield* Effect.tryPromise({
      try: () => state.client.close(state.owner),
      catch: () =>
        failure(
          threadId,
          terminalId,
          "The terminal service didn't confirm that this terminal ended. It may still be running.",
        ),
    });
  if (state.status !== "unsupported") ctx.hostLimit?.refreshRoster?.();
});
