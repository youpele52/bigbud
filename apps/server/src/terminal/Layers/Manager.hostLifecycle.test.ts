import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { Effect } from "effect";
import { describe, expect, it as vitest } from "vitest";

import {
  FakeHostAdapter,
  type FakeHostProcess,
  flush,
  makeHostManager,
} from "./Manager.host.test.helpers.ts";
import { terminalLifecycleNoticeFromHost } from "./Manager.hostLifecycle.ts";
import type { OwnedPtyHostEvent } from "../Services/OwnedPtyRuntime.ts";
import { createManager, openInput } from "./Manager.test.helpers.ts";

const pane = { threadId: "t", terminalId: "a" };
const wait = (ms: number) => Effect.promise(() => new Promise((done) => setTimeout(done, ms)));

describe("host notice mapping", () => {
  vitest("maps every wire kind to its notice and the reason the terminal ended", () => {
    const map = (kind: string, closesAtMs = 0) =>
      terminalLifecycleNoticeFromHost(
        { noticeId: 7, kind, closesAtMs, occurredAtMs: 1_700_000_000_000, ptyId: "pty-1" },
        pane,
      );
    expect(map("idle_warning", 1_700_000_060_000)).toEqual({
      ended: undefined,
      notice: {
        type: "lifecycleNotice",
        noticeId: "host:pty-1:7",
        kind: "idleWarning",
        threadId: "t",
        terminalId: "a",
        closesAt: new Date(1_700_000_060_000).toISOString(),
        createdAt: new Date(1_700_000_000_000).toISOString(),
      },
    });
    const cases: Array<[string, string, string | undefined]> = [
      ["idle_warning_cleared", "idleWarningCleared", undefined],
      ["idle_closed", "idleClosed", "idle"],
      ["pressure_closed", "pressureClosed", "memory"],
      ["pressure_no_candidate", "pressureNoCandidate", undefined],
      ["limit_closed", "limitClosed", "limit"],
      ["orphan_closed", "orphanClosed", "orphan"],
      ["quit_closed", "quitClosed", "quit"],
      ["model_invalid", "modelInvalid", undefined],
      ["spool_degraded", "spoolDegraded", undefined],
    ];
    for (const [wire, kind, ended] of cases)
      expect(map(wire)).toMatchObject({ ended, notice: { kind } });
    // A newer host's unknown kind is ignored, never forwarded to an older contract.
    expect(map("future_kind")).toBeUndefined();
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "host lifecycle in the manager",
  (it) => {
    it.effect("forwards idle warnings and refreshes the sidebar inventory when facts change", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        const { manager } = yield* makeHostManager(adapter);
        const notices: TerminalLifecycleNotice[] = [];
        const inventories: TerminalSessionInventory[] = [];
        yield* manager.subscribeLifecycle!((notice) => Effect.sync(() => notices.push(notice)));
        yield* manager.subscribe(() => Effect.void, {
          onInventory: (inventory) => Effect.sync(() => inventories.push(inventory)),
        });
        yield* manager.open(openInput());
        const process = adapter.processes[0] as FakeHostProcess;
        process.emitActivity(true);
        process.emitNotice("idle_warning", 1_700_000_600_000);
        yield* wait(400);

        expect(notices.map((notice) => notice.kind)).toEqual(["idleWarning"]);
        expect(notices[0]).toMatchObject({ threadId: "thread-1", terminalId: "default" });
        expect(inventories.at(-1)?.sessions).toEqual([
          {
            threadId: "thread-1",
            terminalId: "default",
            activity: "busy",
            restorable: true,
            idleClosesAt: new Date(1_700_000_600_000).toISOString(),
          },
        ]);

        process.emitNotice("idle_warning_cleared", 0, 2);
        process.emitActivity(false);
        yield* wait(400);
        expect(inventories.at(-1)?.sessions[0]).toEqual({
          threadId: "thread-1",
          terminalId: "default",
          activity: "quiet",
          restorable: true,
        });
      }),
    );

    it.effect("reports a close whose exit arrived first, and pane-less host notices", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        let hostListener: ((event: OwnedPtyHostEvent) => void) | undefined;
        Object.assign(adapter.runtime, {
          host: {
            subscribe: async (listener: (event: OwnedPtyHostEvent) => void) => {
              hostListener = listener;
              return () => undefined;
            },
          },
        });
        const { manager } = yield* makeHostManager(adapter);
        const notices: TerminalLifecycleNotice[] = [];
        yield* manager.subscribeLifecycle!((notice) => Effect.sync(() => notices.push(notice)));
        yield* manager.open(openInput());
        yield* Effect.promise(flush);
        const process = adapter.processes[0] as FakeHostProcess;
        process.emitExit({ exitCode: 0, signal: null });
        yield* Effect.promise(flush);
        const notice = (ptyId: string, kind: string, noticeId: number) =>
          hostListener!({
            type: "notice",
            value: { ptyId, kind, noticeId, closesAtMs: 0, occurredAtMs: 1_700_000_000_000 },
          });
        notice("pty-1", "idle_closed", 5);
        notice("", "pressure_no_candidate", 6);
        yield* Effect.promise(flush);
        expect(notices.map((entry) => [entry.kind, entry.terminalId])).toEqual([
          ["idleClosed", "default"],
          ["pressureNoCandidate", undefined],
        ]);
        const snapshot = yield* manager.snapshot({ threadId: "thread-1", terminalId: "default" });
        expect(snapshot.endedReason).toBe("idle");
        // Live notices advance the offline-replay cursor, not only the 30 s tick.
        expect(adapter.generations.seenNotices).toEqual([5, 6]);
      }),
    );

    it.effect("restarts the idle timer on Keep open, and ignores panes without idle close", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        const { manager } = yield* makeHostManager(adapter);
        yield* manager.keepOpen!({ threadId: "thread-1", terminalId: "default" });
        yield* manager.open(openInput());
        yield* manager.keepOpen!({ threadId: "thread-1", terminalId: "default" });
        expect((adapter.processes[0] as FakeHostProcess).keepOpenCalls).toBe(1);
      }),
    );

    it.effect("raises the one-time old-host notice and closes verified old hosts on request", () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        adapter.generations.notices = [
          { generation: 1, reason: "unreachable", firstTime: true, canClose: true },
          { generation: 2, reason: "incompatible", firstTime: false, canClose: false },
        ];
        const { manager } = yield* makeHostManager(adapter);
        yield* Effect.promise(flush);
        const early: TerminalLifecycleNotice[] = [];
        yield* manager.subscribeLifecycle!((notice) => Effect.sync(() => early.push(notice)));
        expect(early.map((notice) => [notice.kind, notice.noticeId])).toEqual([
          ["legacyHostUnreachable", "legacy-host:1"],
        ]);

        expect(yield* manager.closeDrainingHosts!()).toEqual({ closed: 1, remaining: 1 });
        const late: TerminalLifecycleNotice[] = [];
        yield* manager.subscribeLifecycle!((notice) => Effect.sync(() => late.push(notice)));
        expect(late).toEqual([]);
      }),
    );

    it.effect("leaves in-process snapshots and inventories exactly as before", () =>
      Effect.gen(function* () {
        const { manager } = yield* createManager();
        const inventories: TerminalSessionInventory[] = [];
        const opened = yield* manager.open(openInput());
        yield* manager.subscribe(() => Effect.void, {
          onInventory: (inventory) => Effect.sync(() => inventories.push(inventory)),
        });
        expect(opened).not.toHaveProperty("screenSource");
        expect(opened).not.toHaveProperty("restorable");
        expect(opened).not.toHaveProperty("endedReason");
        expect(inventories[0]?.sessions).toEqual([{ threadId: "thread-1", terminalId: "default" }]);
      }),
    );
  },
);
