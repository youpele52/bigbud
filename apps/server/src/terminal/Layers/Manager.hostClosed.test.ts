import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { Effect } from "effect";
import { expect } from "vitest";

import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import type { OwnedPtyHostEvent } from "../Services/OwnedPtyRuntime.ts";
import {
  FakeHostAdapter,
  type FakeHostProcess,
  flush,
  makeHostManager,
} from "./Manager.host.test.helpers.ts";
import { createManager, openInput } from "./Manager.test.helpers.ts";

const wait = (ms: number) => Effect.promise(() => new Promise((done) => setTimeout(done, ms)));

/** A host adapter whose host-wide notices the test can raise (they follow the PTY's exit). */
function hostWithEvents() {
  const adapter = new FakeHostAdapter();
  let listener: ((event: OwnedPtyHostEvent) => void) | undefined;
  Object.assign(adapter.runtime, {
    host: {
      subscribe: async (next: (event: OwnedPtyHostEvent) => void) => {
        listener = next;
        return () => undefined;
      },
    },
  });
  const notice = (ptyId: string, kind: string, noticeId: number) =>
    listener!({
      type: "notice",
      value: { ptyId, kind, noticeId, closesAtMs: 0, occurredAtMs: 1_700_000_000_000 },
    });
  return { adapter, notice };
}

it.layer(NodeServices.layer, { excludeTestServices: true })("host-closed terminals", (it) => {
  for (const [wire, reason] of [
    ["idle_closed", "idle"],
    ["pressure_closed", "memory"],
    ["limit_closed", "limit"],
    ["orphan_closed", "orphan"],
  ] as const)
    it.effect(`never respawns a pane the host closed (${reason}) on a plain open`, () =>
      Effect.gen(function* () {
        const { adapter, notice } = hostWithEvents();
        const { manager } = yield* makeHostManager(adapter);
        yield* manager.open(openInput());
        yield* Effect.promise(flush);
        const process = adapter.processes[0] as FakeHostProcess;
        // The host reports the close after the reap, so the exit arrives first.
        process.emitExit({ exitCode: 143, signal: 15 });
        yield* Effect.promise(flush);
        notice("pty-1", wire, 3);
        yield* Effect.promise(flush);

        // A parked view that comes back opens without attachOnly: it must not spawn.
        const reopened = yield* manager.open(openInput());
        expect(adapter.spawnInputs).toHaveLength(1);
        expect(reopened).toMatchObject({ status: "exited", pid: null, endedReason: reason });
        // Attach-only gets the same ended session.
        const attached = yield* manager.open(openInput({ attachOnly: true }));
        expect(attached).toMatchObject({ status: "exited", endedReason: reason });
        expect(adapter.spawnInputs).toHaveLength(1);
        // A fresh terminal comes only from New terminal, with a new id.
        yield* manager.open(openInput({ terminalId: "term-2" }));
        expect(adapter.spawnInputs).toHaveLength(2);
      }),
    );

  it.effect("still reopens a shell the user exited, exactly as before", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      const { manager } = yield* makeHostManager(adapter);
      yield* manager.open(openInput());
      yield* Effect.promise(flush);
      (adapter.processes[0] as FakeHostProcess).emitExit({ exitCode: 0, signal: null });
      yield* Effect.promise(flush);
      const reopened = yield* manager.open(openInput());
      expect(adapter.spawnInputs).toHaveLength(2);
      expect(reopened.status).toBe("running");
    }),
  );

  it.effect("lists an idle-closed session as not live in the refreshed inventory", () =>
    Effect.gen(function* () {
      const { adapter, notice } = hostWithEvents();
      const { manager } = yield* makeHostManager(adapter);
      const inventories: TerminalSessionInventory[] = [];
      yield* manager.subscribe(() => Effect.void, {
        onInventory: (inventory) => Effect.sync(() => inventories.push(inventory)),
      });
      yield* manager.open(openInput());
      yield* wait(400);
      expect(inventories.at(-1)?.sessions[0]).not.toHaveProperty("live");
      (adapter.processes[0] as FakeHostProcess).emitExit({ exitCode: 143, signal: 15 });
      yield* Effect.promise(flush);
      notice("pty-1", "idle_closed", 4);
      yield* wait(400);
      expect(inventories.at(-1)?.sessions).toEqual([
        {
          threadId: "thread-1",
          terminalId: "default",
          live: false,
          activity: "quiet",
          restorable: false,
        },
      ]);
    }),
  );

  it.effect("marks exited in-process sessions not live, and lost host PTYs too", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: null });
      yield* Effect.promise(flush);
      const inventories: TerminalSessionInventory[] = [];
      yield* manager.subscribe(() => Effect.void, {
        onInventory: (inventory) => Effect.sync(() => inventories.push(inventory)),
      });
      expect(inventories[0]?.sessions).toEqual([
        { threadId: "thread-1", terminalId: "default", live: false },
      ]);

      const adapter = new FakeHostAdapter();
      adapter.ownership.rows.set('terminal:["thread-2","lost"]', {
        ...profileOwner(),
        ownerKey: 'terminal:["thread-2","lost"]',
        target: "local-terminal-host",
        resourceId: "pty-lost",
        state: "may-have-been-sent",
      });
      adapter.generations.inventoryEntries = [
        {
          ptyId: "pty-lost",
          connectionId: "state-1",
          state: "outcome-unknown",
          lost: true,
          lifecycleManaged: true,
        },
      ];
      const host = yield* makeHostManager(adapter);
      yield* Effect.promise(flush);
      const hostInventories: TerminalSessionInventory[] = [];
      yield* host.manager.subscribe(() => Effect.void, {
        onInventory: (inventory) => Effect.sync(() => hostInventories.push(inventory)),
      });
      expect(hostInventories[0]?.sessions).toEqual([
        { threadId: "thread-2", terminalId: "lost", live: false, activity: "quiet" },
      ]);
    }),
  );
});
