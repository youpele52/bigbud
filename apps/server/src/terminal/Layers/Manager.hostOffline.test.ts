import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { Effect } from "effect";
import { afterEach, describe, expect, it as vitest, vi } from "vitest";

import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { TerminalViewRegistry } from "../activity/terminalViewRegistry.ts";
import type { OwnedPtyHostGenerationReplay } from "../Services/OwnedPtyRuntime.ts";
import { FakeHostAdapter, flush, makeHostManager } from "./Manager.host.test.helpers.ts";
import { makeTerminalHostHub, TERMINAL_HOST_TICK_MS } from "./Manager.hostHub.ts";
import { offlineClosedNotice } from "./Manager.hostInventory.ts";
import { openInput } from "./Manager.test.helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

const replay = (
  kinds: ReadonlyArray<string>,
  extra: Partial<OwnedPtyHostGenerationReplay> = {},
): OwnedPtyHostGenerationReplay => ({
  generation: 1,
  agentEpoch: "epoch-1",
  notices: kinds.map((kind, index) => ({
    noticeId: index + 1,
    ptyId: `pty-${index}`,
    kind,
    closesAtMs: 0,
    occurredAtMs: 1_700_000_000_000,
  })),
  gap: false,
  baseline: false,
  lastNoticeId: kinds.length,
  ...extra,
});

describe("offline summary", () => {
  vitest("counts idle and orphan closes only, never a baseline or the user's own quit", () => {
    const notice = offlineClosedNotice(
      [
        replay(["idle_closed", "orphan_closed", "quit_closed", "idle_warning"]),
        replay(["idle_closed"], { generation: 2, baseline: true }),
      ],
      "2026-11-21T10:00:00.000Z",
    );
    expect(notice).toEqual({
      type: "lifecycleNotice",
      noticeId: "offline:1.epoch-1.4",
      kind: "offlineClosed",
      count: 2,
      createdAt: "2026-11-21T10:00:00.000Z",
    });
    expect(offlineClosedNotice([replay(["quit_closed"])], "x")).toBeUndefined();
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })("offline replay on adoption", (it) => {
  it.effect("raises one summary at adoption, also for renderers that connect later", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      adapter.generations.pendingReplays = [replay(["idle_closed", "idle_closed"])];
      const { manager } = yield* makeHostManager(adapter);
      yield* Effect.promise(flush);
      const first: TerminalLifecycleNotice[] = [];
      const second: TerminalLifecycleNotice[] = [];
      yield* manager.subscribeLifecycle!((notice) => Effect.sync(() => first.push(notice)));
      yield* manager.subscribeLifecycle!((notice) => Effect.sync(() => second.push(notice)));
      expect(first).toEqual([expect.objectContaining({ kind: "offlineClosed", count: 2 })]);
      // A reconnecting renderer gets the same notice id, which the web shows once.
      expect(second.map((notice) => notice.noticeId)).toEqual([first[0]!.noticeId]);
      expect(adapter.generations.replayCalls).toBe(1);
    }),
  );

  it.effect("sets the notice cursor of a host first admitted after startup at once", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      // No host at startup; the first terminal launches one.
      adapter.generations.admitted = undefined as unknown as string;
      const { manager } = yield* makeHostManager(adapter);
      yield* Effect.promise(flush);
      expect(adapter.generations.replayCalls).toBe(1);
      adapter.generations.admitted = "state-1:epoch-1";
      yield* manager.open(openInput());
      yield* Effect.promise(flush);
      // Without this the cursor would wait for the next tick, and a keep-mode quit before it
      // would turn every close while bigbud was closed into an unsummarised baseline.
      expect(adapter.generations.replayCalls).toBe(2);
      yield* manager.open(openInput({ terminalId: "second" }));
      yield* Effect.promise(flush);
      expect(adapter.generations.replayCalls).toBe(2);
    }),
  );
});

describe("periodic host tick", () => {
  vitest(
    "refreshes the roster and inventory, advances cursors, and treats a new host as a reconnect",
    async () => {
      vi.useFakeTimers();
      const adapter = new FakeHostAdapter();
      const inventories: TerminalSessionInventory[] = [];
      const published: TerminalLifecycleNotice[] = [];
      const hub = makeTerminalHostHub({
        runtime: () => adapter.runtime,
        keepRunningAfterQuit: () => false,
        views: new TerminalViewRegistry(),
        sessions: () => [],
        inventory: () =>
          Effect.succeed({ type: "inventory", createdAt: "now", sessions: hub.roster.entries() }),
        runFork: (effect) => void Effect.runFork(effect),
        log: () => undefined,
      });
      hub.registerInventoryListener((inventory) => Effect.sync(() => inventories.push(inventory)));
      await hub.start();
      hub
        .subscribeLifecycle((notice) => Effect.sync(() => published.push(notice)))
        .pipe(Effect.runSync);
      expect(adapter.generations.policies).toHaveLength(1);
      const before = adapter.generations.replayCalls;

      // A terminal appears in the host after startup (opened by another backend window).
      const ownerKey = `terminal:${JSON.stringify(["thread-9", "late"])}`;
      adapter.ownership.rows.set(ownerKey, {
        ...profileOwner(),
        ownerKey,
        target: "local-terminal-host",
        resourceId: "pty-late",
        state: "may-have-been-sent",
      });
      adapter.generations.inventoryEntries = [
        {
          ptyId: "pty-late",
          connectionId: "state-1",
          state: "running",
          lost: false,
          lifecycleManaged: true,
        },
      ];
      adapter.generations.admitted = "state-2:epoch-2";
      adapter.generations.pendingReplays = [replay(["idle_closed"])];
      await vi.advanceTimersByTimeAsync(TERMINAL_HOST_TICK_MS + 300);

      expect(hub.roster.entries().map((entry) => entry.terminalId)).toEqual(["late"]);
      expect(inventories.at(-1)?.sessions).toEqual([
        expect.objectContaining({ terminalId: "late" }),
      ]);
      expect(adapter.generations.replayCalls).toBe(before + 1);
      // Runtime notices only advance the cursor; the offline toast is raised at adoption only.
      expect(published).toEqual([]);
      expect(adapter.generations.policies).toHaveLength(2);
      hub.dispose();
    },
  );
});
