import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { Effect } from "effect";
import { expect } from "vitest";

import type { PtyHostCapabilities, PtySpawnInput } from "../Services/PTY.ts";
import {
  ALL_CAPABILITIES,
  FakeHostAdapter,
  type FakeHostProcess,
  flush,
  makeHostManager,
} from "./Manager.host.test.helpers.ts";
import { openInput } from "./Manager.test.helpers.ts";

/**
 * A PTY on a protocol 1.9 remote agent created with the terminal host flag off reports no
 * screen or lifecycle (its owned-PTY wrapper limits the connection's capabilities to what the
 * create asked for). The manager must then treat it exactly as before.
 */
const UNMANAGED: PtyHostCapabilities = {
  screen: false,
  lifecycle: false,
  spool: false,
  queryResponder: false,
  localLaunch: true,
};

class FeatureAdapter extends FakeHostAdapter {
  constructor(private readonly hostCapabilities: PtyHostCapabilities) {
    super();
  }
  override spawn(input: PtySpawnInput) {
    return super
      .spawn(input)
      .pipe(
        Effect.tap((process) =>
          Effect.sync(() => Object.assign(process, { capabilities: this.hostCapabilities })),
        ),
      );
  }
}

const run = (capabilities: PtyHostCapabilities) =>
  Effect.gen(function* () {
    const adapter = new FeatureAdapter(capabilities);
    const { manager } = yield* makeHostManager(adapter);
    const opened = yield* manager.open(openInput());
    const process = adapter.processes[0] as FakeHostProcess;
    const screens: unknown[] = [];
    const handle = yield* manager.subscribeSession!(
      { threadId: "thread-1", terminalId: "default", acceptScreen: true },
      { screen: (item) => screens.push(item), event: () => undefined, overflow: () => undefined },
    );
    handle.start();
    yield* Effect.promise(flush);
    const inventories: TerminalSessionInventory[] = [];
    yield* manager.subscribe(() => Effect.void, {
      onInventory: (inventory) => Effect.sync(() => inventories.push(inventory)),
    });
    process.emitActivity(true);
    process.emitNotice("idle_warning", 1_700_000_600_000);
    yield* Effect.promise(flush);
    const snapshot = yield* manager.snapshot({ threadId: "thread-1", terminalId: "default" });
    return { opened, snapshot, process, screens, inventory: inventories[0]?.sessions };
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("per-PTY host features", (it) => {
  it.effect("an unmanaged PTY on a 1.9 host gets no host state: plain live output as before", () =>
    Effect.gen(function* () {
      const { opened, snapshot, process, screens, inventory } = yield* run(UNMANAGED);
      for (const view of [opened, snapshot]) {
        expect(view).not.toHaveProperty("screenSource");
        expect(view).not.toHaveProperty("restorable");
      }
      // No screen copy is ever requested, so the host's SCREEN_UNAVAILABLE path is never hit.
      expect(process.snapshotRequests).toEqual([]);
      expect(screens).toEqual([]);
      // No lifecycle handling: no view-state pushes and no idle facts in the inventory.
      expect(process.viewStates).toEqual([]);
      expect(inventory).toEqual([{ threadId: "thread-1", terminalId: "default" }]);
    }),
  );

  it.effect("a managed PTY (flag on) is unchanged: restorable with host screen copies", () =>
    Effect.gen(function* () {
      const { opened, process, screens } = yield* run(ALL_CAPABILITIES);
      expect(opened).toMatchObject({ screenSource: "host", restorable: true });
      expect(process.snapshotRequests).toHaveLength(1);
      expect(screens).toHaveLength(1);
      expect(process.viewStates.length).toBeGreaterThan(0);
    }),
  );
});
