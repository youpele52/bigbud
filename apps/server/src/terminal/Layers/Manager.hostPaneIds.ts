/**
 * Pane identity for direct-shell deletion guards (plan S3, N8). `knownThreadTerminalIds`
 * matches a thread's direct-shell owner records against its pane ids, which used to come from
 * history files alone. Host-backed panes are also known from their durable owner rows and the
 * host roster (lost entries included), so the set of known panes never shrinks.
 *
 * @module Manager.hostPaneIds
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import { paneFromOwnerKey } from "./Manager.hostLimit.ts";
import { listTerminalHostOwners, type TerminalHostRosterEntry } from "./Manager.hostRoster.ts";

export const terminalPaneIdsForThread = Effect.fn("terminal.paneIdsForThread")(function* (input: {
  readonly threadId: string;
  readonly history: Effect.Effect<ReadonlyArray<string> | "unknown">;
  readonly runtime: OwnedPtyRuntime | undefined;
  readonly roster: ReadonlyArray<TerminalHostRosterEntry>;
}) {
  const history = yield* input.history;
  const runtime = input.runtime;
  // Without a terminal host the answer is exactly the history listing, as before.
  if (!runtime?.hostGenerations || history === "unknown") return history;
  const owners = yield* Effect.tryPromise(() => listTerminalHostOwners(runtime)).pipe(
    Effect.option,
  );
  // An unreadable owner table is never proof that a pane is gone.
  if (Option.isNone(owners)) return "unknown" as const;
  const ids = new Set(history);
  for (const owner of owners.value) {
    const pane = paneFromOwnerKey(owner.ownerKey);
    if (pane?.threadId === input.threadId) ids.add(pane.terminalId);
  }
  for (const entry of input.roster)
    if (entry.threadId === input.threadId) ids.add(entry.terminalId);
  return [...ids];
});
