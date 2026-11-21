/**
 * Builds the manager's host wiring (plan S3) from its state and options. With no host runtime
 * (the flag off, Windows) every piece is inert and the manager behaves exactly as before.
 *
 * @module Manager.process.host
 */
import type { TerminalEvent } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { terminalViews } from "../activity/terminalViewRegistry.ts";
import { makeTerminalHostHub } from "./Manager.hostHub.ts";
import { terminalInventorySessions } from "./Manager.hostInventory.ts";
import type { TerminalHostLimitContext } from "./Manager.hostLimit.ts";
import { terminalPaneIdsForThread } from "./Manager.hostPaneIds.ts";
import { applyTerminalQuitPolicy } from "./Manager.quitPolicy.ts";
import { makeTerminalSessionHostApi } from "./Manager.session.host.ts";
import type { TerminalHostInventorySource } from "./Manager.session.subscription.ts";
import { toSessionKey } from "./Manager.shell";
import type {
  TerminalManagerOptions,
  TerminalManagerState,
  TerminalSessionState,
} from "./Manager.types";

export function makeTerminalManagerHost(input: {
  readonly options: TerminalManagerOptions;
  readonly stateRef: SynchronizedRef.SynchronizedRef<TerminalManagerState>;
  readonly runFork: (effect: Effect.Effect<void>) => void;
}) {
  const { options, stateRef } = input;
  // The local terminal host is the only multi-generation host; remote agents add per-PTY
  // capabilities through their processes alone.
  const runtime = () => options.ptyAdapter.ownedRuntimeForTarget?.("local");
  const keepRunningAfterQuit = () => options.keepRunningAfterQuit?.() === true;
  const sessions = () => SynchronizedRef.getUnsafe(stateRef).sessions.values();
  const log = (message: string, detail: Record<string, unknown>) =>
    input.runFork(Effect.logWarning(message, detail));
  const hub = makeTerminalHostHub({
    runtime,
    keepRunningAfterQuit,
    views: options.views ?? terminalViews,
    sessions,
    inventory: () =>
      Effect.sync(() => ({
        type: "inventory" as const,
        createdAt: new Date().toISOString(),
        sessions: terminalInventorySessions(sessions(), hub.roster.entries()),
      })),
    runFork: input.runFork,
    log,
    ...(options.onSettingsChange ? { onSettingsChange: options.onSettingsChange } : {}),
  });
  const hostInventory: TerminalHostInventorySource = {
    ready: runtime()?.hostGenerations ? Effect.promise(() => hub.roster.ready()) : Effect.void,
    sessions: (current) => terminalInventorySessions(current, hub.roster.entries()),
    register: hub.registerInventoryListener,
  };
  const hostLimit: TerminalHostLimitContext = {
    sessions: () => Effect.sync(() => [...sessions()]),
    roster: () => hub.roster.entries(),
    runtime: runtime(),
  };
  return {
    hub,
    hostInventory,
    hostLimit,
    start: () => {
      input.runFork(Effect.promise(() => hub.start()));
    },
    historyTerminalIdsForThread:
      (history: (threadId: string) => Effect.Effect<ReadonlyArray<string> | "unknown">) =>
      (threadId: string) =>
        terminalPaneIdsForThread({
          threadId,
          history: history(threadId),
          runtime: runtime(),
          roster: hub.roster.entries(),
        }),
    api: (deps: {
      readonly getSession: (
        threadId: string,
        terminalId: string,
      ) => Effect.Effect<Option.Option<TerminalSessionState>>;
      readonly subscribe: (
        listener: (event: TerminalEvent) => Effect.Effect<void>,
      ) => Effect.Effect<() => void>;
    }) =>
      makeTerminalSessionHostApi({
        hub,
        runtime,
        readSession: (threadId, terminalId) =>
          SynchronizedRef.getUnsafe(stateRef).sessions.get(toSessionKey(threadId, terminalId)),
        getSession: (threadId, terminalId) =>
          deps.getSession(threadId, terminalId).pipe(Effect.map(Option.getOrUndefined)),
        subscribe: deps.subscribe,
      }),
    /** Shutdown: the quit decision first, while sessions are still attached. */
    shutdown: applyTerminalQuitPolicy({
      resolveIntent: options.resolveQuitIntent,
      keepRunningAfterQuit,
      runtime,
    }).pipe(Effect.ensuring(Effect.sync(() => hub.dispose())), Effect.ignoreCause({ log: true })),
  };
}
