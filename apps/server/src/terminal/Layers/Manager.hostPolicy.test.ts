import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { TERMINAL_VIEW_LEASE_MS } from "@bigbud/contracts/workspace/terminal.activity.ts";
import { Effect } from "effect";
import { afterEach, describe, expect, it as vitest, vi } from "vitest";

import { TerminalViewRegistry } from "../activity/terminalViewRegistry.ts";
import {
  FakeHostAdapter,
  FakeHostProcess,
  flush,
  makeHostManager,
} from "./Manager.host.test.helpers.ts";
import { makeTerminalHostHub } from "./Manager.hostHub.ts";
import { TerminalHostOutputLedger } from "./Manager.hostScreen.ledger.ts";
import { terminalHostPolicy } from "./Manager.hostPolicy.ts";
import type { TerminalSessionState } from "./Manager.types.ts";
import { openInput } from "./Manager.test.helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("host policy", () => {
  vitest("opts in with the plan's constants; keep mode keeps orphans", () => {
    expect(terminalHostPolicy({ keepRunningAfterQuit: false, revision: 5 })).toMatchObject({
      lifecycleEnabled: true,
      idleCloseMs: 600_000,
      idleWarningMs: 60_000,
      maxLivePtys: 24,
      orphanCloseMs: 600_000,
      memoryPressureEnabled: true,
      revision: 5,
    });
    expect(terminalHostPolicy({ keepRunningAfterQuit: true, revision: 6 }).orphanCloseMs).toBe(0);
  });

  vitest("pushes hidden once a view's lease lapses with no new report", async () => {
    vi.useFakeTimers();
    const views = new TerminalViewRegistry();
    const process = new FakeHostProcess(1, "pty-1");
    const session = {
      threadId: "t",
      terminalId: "a",
      status: "running",
      process,
      host: {
        generation: "g",
        ptyId: "pty-1",
        ledger: new TerminalHostOutputLedger(),
        screen: true,
        restorable: true,
        lifecycle: true,
      },
    } as unknown as TerminalSessionState;
    const hub = makeTerminalHostHub({
      runtime: () => undefined,
      keepRunningAfterQuit: () => false,
      views,
      sessions: () => [session],
      inventory: () => Effect.die("unused"),
      runFork: (effect) => void Effect.runFork(effect),
      log: () => undefined,
    });
    views.update("caller", { threadId: "t", terminalIds: ["a"] });
    expect(process.viewStates.at(-1)).toEqual({ viewState: "visible", rendererAttached: false });
    await vi.advanceTimersByTimeAsync(TERMINAL_VIEW_LEASE_MS + 50);
    expect(process.viewStates.at(-1)).toEqual({ viewState: "hidden", rendererAttached: false });
    expect(process.viewStates).toHaveLength(2);
    hub.dispose();
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })("host policy in the manager", (it) => {
  it.effect("pushes the policy on connect and again when the keep setting changes", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      let keep = false;
      const listeners = new Set<() => void>();
      yield* makeHostManager(adapter, {
        keepRunningAfterQuit: () => keep,
        onSettingsChange: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
      yield* Effect.promise(flush);
      expect(adapter.generations.policies.map((policy) => policy.orphanCloseMs)).toEqual([600_000]);
      keep = true;
      for (const listener of listeners) listener();
      yield* Effect.promise(flush);
      expect(adapter.generations.policies.map((policy) => policy.orphanCloseMs)).toEqual([
        600_000, 0,
      ]);
      // A reconnect to a fresh host generation pushes again.
      adapter.generations.admitted = "state-2:epoch-2";
      for (const listener of listeners) listener();
      yield* Effect.promise(flush);
      expect(adapter.generations.policies).toHaveLength(3);
      const revisions = adapter.generations.policies.map((policy) => policy.revision);
      expect([...revisions].toSorted((a, b) => a - b)).toEqual(revisions);
    }),
  );

  it.effect("reports visibility and renderer attachment, with the acked sequence on detach", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      const { manager, views } = yield* makeHostManager(adapter);
      yield* manager.open(openInput());
      const process = adapter.processes[0] as FakeHostProcess;
      yield* Effect.promise(flush);
      expect(process.viewStates.at(-1)).toEqual({ viewState: "hidden", rendererAttached: false });

      process.screenText = "";
      const view = yield* manager.subscribeSession!(
        { threadId: "thread-1", terminalId: "default", acceptScreen: true },
        { screen: () => undefined, event: () => undefined, overflow: () => undefined },
      );
      view.start();
      yield* Effect.promise(flush);
      expect(process.viewStates.at(-1)).toEqual({ viewState: "hidden", rendererAttached: true });

      views.update("caller", { threadId: "thread-1", terminalIds: ["default"] });
      expect(process.viewStates.at(-1)).toEqual({ viewState: "visible", rendererAttached: true });

      process.emitHost("abc");
      process.emitHost("def");
      yield* Effect.promise(flush);
      view.unsubscribe(3);
      expect(process.viewStates.at(-1)).toEqual({
        viewState: "visible",
        rendererAttached: false,
        ackedSequence: 1,
      });
      views.forget("caller");
      expect(process.viewStates.at(-1)).toMatchObject({ viewState: "hidden" });
    }),
  );
});
