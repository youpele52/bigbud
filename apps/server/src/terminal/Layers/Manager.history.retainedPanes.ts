/**
 * Which of a thread's panes must keep their history file when the thread's history is deleted
 * (plan Q1, N8). A history file is how `knownThreadTerminalIds` recognises a pane, and the
 * direct-shell deletion guard matches owner records against those ids. So a pane keeps its file
 * while it still has a direct-shell owner record (version 1 or a hosted version 2 record), a
 * non-terminal row in the local host's owner table, or a lost PTY in the host inventory.
 *
 * @module Manager.history.retainedPanes
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { paneFromOwnerKey } from "./Manager.hostLimit.ts";
import { listTerminalHostOwners } from "./Manager.hostRoster.ts";
import type { SessionApiContext } from "./Manager.session.types";

type RetainedPanesContext = Pick<SessionApiContext, "directShellOwners" | "hostLimit">;

/**
 * Pane ids whose history must survive, or `"unknown"` when any source cannot be read (the caller
 * then deletes nothing). `knownTerminalIds` resolves legacy owners that carry only a key hash.
 * `confirmedStopped` are panes whose process this close just confirmed stopped: a host owner
 * row that has not caught up yet does not hold their history back.
 */
export const retainedHistoryTerminalIds = Effect.fn("terminal.retainedHistoryTerminalIds")(
  function* (
    ctx: RetainedPanesContext,
    threadId: string,
    knownTerminalIds: ReadonlyArray<string>,
    confirmedStopped: ReadonlySet<string> = new Set(),
  ) {
    const retained = new Set<string>();
    const byKey = new Map(
      knownTerminalIds.map((terminalId) => [directShellOwnerKey(threadId, terminalId), terminalId]),
    );
    const store = ctx.directShellOwners;
    const read = <A>(load: () => Promise<A>) => Effect.tryPromise(load).pipe(Effect.option);

    if (store?.listForThread) {
      const listForThread = store.listForThread;
      const owners = yield* read(() => listForThread(threadId, (key) => byKey.has(key)));
      if (Option.isNone(owners)) return "unknown" as const;
      for (const owner of owners.value) {
        const terminalId = owner.pane?.terminalId ?? byKey.get(owner.ownerKey);
        if (terminalId !== undefined) retained.add(terminalId);
      }
    }
    if (store?.listHostedForThread) {
      const listHostedForThread = store.listHostedForThread;
      const hosted = yield* read(() => listHostedForThread(threadId));
      if (Option.isNone(hosted)) return "unknown" as const;
      for (const record of hosted.value) retained.add(record.pane.terminalId);
    }

    const runtime = ctx.hostLimit?.runtime;
    if (runtime?.hostGenerations) {
      const owners = yield* read(() => listTerminalHostOwners(runtime));
      if (Option.isNone(owners)) return "unknown" as const;
      for (const owner of owners.value) {
        // A terminal row is a confirmed exit: no PTY is left for the file to identify.
        if (owner.state === "terminal") continue;
        const pane = paneFromOwnerKey(owner.ownerKey);
        if (pane?.threadId === threadId && !confirmedStopped.has(pane.terminalId))
          retained.add(pane.terminalId);
      }
      // A lost PTY keeps only its cold screen; it is still this thread's pane.
      for (const entry of ctx.hostLimit?.roster() ?? [])
        if (entry.threadId === threadId && entry.lost && !confirmedStopped.has(entry.terminalId))
          retained.add(entry.terminalId);
    }
    return retained as ReadonlySet<string>;
  },
);
