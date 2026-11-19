import type {
  TerminalFinishedItem,
  TerminalWorkActivity,
} from "@bigbud/contracts/workspace/terminal.activity.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { organizationOwner } from "../../thread-organization/organizationOwner.ts";
import { TerminalActivity, type TerminalActivityShape } from "../Services/TerminalActivity.ts";
import { decideTerminalFinished } from "../activity/terminalFinishedPolicy.ts";
import {
  TerminalRecencyCoalescer,
  type TerminalRecencyWrite,
} from "../activity/terminalRecencyCoalescer.ts";
import { terminalViews, type TerminalViewRegistry } from "../activity/terminalViewRegistry.ts";
import {
  clearTerminalFinished,
  countTerminalFinished,
  listRaisedTerminalThreads,
  pruneTerminalFinished,
  upsertTerminalFinished,
  writeTerminalRecency,
} from "../activity/terminalActivity.sql.ts";

const TICK_MS = 1_000;

export interface TerminalActivityOptions {
  readonly views?: TerminalViewRegistry;
  readonly now?: () => number;
  readonly coalescer?: TerminalRecencyCoalescer;
}

/** Persistence failures are logged, never surfaced to keystrokes or PTY output. */
const quietly = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning(`terminal activity: ${label} failed`, cause)),
  );

export const makeTerminalActivity = Effect.fn("makeTerminalActivity")(function* (
  options: TerminalActivityOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const views = options.views ?? terminalViews;
  const now = options.now ?? Date.now;
  const coalescer = options.coalescer ?? new TerminalRecencyCoalescer();
  const listeners = new Set<(item: TerminalWorkActivity) => Effect.Effect<void>>();
  // Threads with raised items, so Enter/view reports skip SQLite when nothing needs clearing.
  const raised = new Set(
    yield* listRaisedTerminalThreads(sql).pipe(Effect.orElseSucceed(() => [])),
  );

  const publish = (item: Omit<TerminalWorkActivity, "type" | "createdAt">) =>
    Effect.forEach(
      [...listeners],
      (listener) =>
        listener({ type: "workActivity", createdAt: new Date(now()).toISOString(), ...item }).pipe(
          Effect.ignoreCause({ log: true }),
        ),
      { discard: true },
    );
  // Organiser facts are sampled on demand; this only marks the thread for a prompt refresh.
  const observe = (threadId: string) =>
    Effect.sync(() => organizationOwner(sql)?.observe?.([threadId]));

  const persistRecency = (write: TerminalRecencyWrite) =>
    Effect.gen(function* () {
      const at = new Date(write.atMs).toISOString();
      const moved = yield* writeTerminalRecency(sql, write.threadId, at);
      if (moved)
        yield* publish({
          threadId: write.threadId,
          terminalId: write.terminalId,
          latestActivityAt: at,
        });
    });
  const recordRecency = (threadId: string, terminalId: string, atMs: number) =>
    Effect.suspend(() => {
      const write = coalescer.record(threadId, terminalId, atMs, now());
      return write ? quietly("recency write", persistRecency(write)) : Effect.void;
    });

  const clear = (threadId: string, terminalId?: string) =>
    !raised.has(threadId)
      ? Effect.void
      : quietly(
          "clear finished",
          Effect.gen(function* () {
            const cleared = yield* clearTerminalFinished(sql, threadId, terminalId);
            if (terminalId === undefined || (yield* countTerminalFinished(sql, threadId)) === 0)
              raised.delete(threadId);
            if (cleared.length === 0) return;
            yield* observe(threadId);
            for (const id of cleared) yield* publish({ threadId, terminalId: id, finished: null });
          }),
        );

  const submit: TerminalActivityShape["submit"] = (threadId, terminalId, atMs) =>
    recordRecency(threadId, terminalId, atMs).pipe(Effect.andThen(clear(threadId, terminalId)));

  const finished: TerminalActivityShape["finished"] = (threadId, terminalId, candidate) =>
    Effect.suspend(() => {
      const decision = decideTerminalFinished(
        candidate,
        views.isViewed(threadId, terminalId, now()),
      );
      if (decision !== "raise") return Effect.void;
      const item: TerminalFinishedItem = {
        terminalId,
        finishedAt: new Date(candidate.atMs).toISOString(),
        ...(candidate.command ? { command: candidate.command } : {}),
        exitCode: candidate.exitCode,
        durationMs: candidate.durationMs,
        source: candidate.source,
      };
      return quietly(
        "raise finished",
        Effect.gen(function* () {
          if (!(yield* upsertTerminalFinished(sql, threadId, item))) return;
          raised.add(threadId);
          yield* observe(threadId);
          yield* publish({ threadId, terminalId, finished: item });
          yield* recordRecency(threadId, terminalId, candidate.atMs);
        }),
      );
    });

  const view: TerminalActivityShape["view"] = (caller, input) =>
    Effect.suspend(() => {
      const change = views.update(caller, input, now());
      return Effect.andThen(
        change.openedThreadId ? clear(change.openedThreadId) : Effect.void,
        Effect.forEach(change.viewedPanes, (pane) => clear(pane.threadId, pane.terminalId), {
          discard: true,
        }),
      );
    });

  const subscribe: TerminalActivityShape["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });

  const flushDue = Effect.suspend(() =>
    Effect.forEach(
      coalescer.takeDue(now()),
      (write) => quietly("recency write", persistRecency(write)),
      {
        discard: true,
      },
    ),
  );
  yield* quietly("startup prune", pruneTerminalFinished(sql));
  yield* Effect.forkScoped(Effect.forever(flushDue.pipe(Effect.andThen(Effect.sleep(TICK_MS)))));
  yield* Effect.addFinalizer(() =>
    Effect.forEach(coalescer.drain(), (write) => quietly("recency flush", persistRecency(write)), {
      discard: true,
    }),
  );
  return { submit, finished, view, subscribe, flushDue } satisfies TerminalActivityShape & {
    flushDue: Effect.Effect<void>;
  };
});

export const TerminalActivityLive = Layer.effect(TerminalActivity, makeTerminalActivity());
