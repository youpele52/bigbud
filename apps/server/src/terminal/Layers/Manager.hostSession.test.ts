import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalEvent } from "@bigbud/contracts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type {
  TerminalScreenItem,
  TerminalSessionInventory,
} from "@bigbud/contracts/workspace/terminal.stream.ts";
import { Effect, FileSystem } from "effect";
import path from "node:path";
import { expect } from "vitest";

import type { TerminalManagerShape } from "../Services/Manager.ts";
import { historyPath } from "./Manager.history-io.ts";
import {
  FakeHostAdapter,
  type FakeHostProcess,
  flush,
  makeHostManager,
} from "./Manager.host.test.helpers.ts";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { openInput } from "./Manager.test.helpers.ts";

const subscribeView = (manager: TerminalManagerShape, terminalId = "default") =>
  Effect.gen(function* () {
    const items: Array<TerminalScreenItem | TerminalEvent> = [];
    const handle = yield* manager.subscribeSession!(
      { threadId: "thread-1", terminalId, acceptScreen: true },
      {
        screen: (item) => items.push(item),
        event: (event) => items.push(event),
        overflow: () => undefined,
      },
    );
    handle.start();
    const texts = () =>
      items.flatMap((item) =>
        item.type === "screen"
          ? [`[screen ${item.throughSequence}${item.cold ? " cold" : ""}]`]
          : item.type === "output"
            ? [item.data]
            : [],
      );
    return { items, texts, handle };
  });

const writeHistory = (logsDir: string, terminalId = "default") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = historyPath(logsDir, "thread-1", terminalId);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "prompt$ ");
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("host-backed sessions", (it) => {
  it.effect(
    "sends the screen first and cuts live output at its sequence, dropping duplicates",
    () =>
      Effect.gen(function* () {
        const adapter = new FakeHostAdapter();
        const { manager } = yield* makeHostManager(adapter);
        const opened = yield* manager.open(openInput());
        expect(opened).toMatchObject({ screenSource: "host", restorable: true });
        const process = adapter.processes[0] as FakeHostProcess;
        process.emitHost("one ");
        yield* Effect.promise(flush);
        const gate = Promise.withResolvers<void>();
        process.snapshotGate = gate.promise;
        process.snapshotThrough = 3;
        const view = yield* subscribeView(manager);
        process.emitHost("two ");
        process.emitHost("three ");
        process.emitHost("four");
        yield* Effect.promise(flush);
        gate.resolve();
        yield* Effect.promise(flush);

        expect(process.snapshotRequests[0]).toMatchObject({ attachRenderer: true });
        expect(view.texts()).toEqual(["[screen 3]", "four"]);
        view.handle.unsubscribe(0);
      }),
  );

  it.effect("keeps the in-process stream unchanged without a host screen", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      const { manager } = yield* makeHostManager(adapter);
      yield* manager.open(openInput());
      const process = adapter.processes[0] as FakeHostProcess;
      const plain = yield* manager.subscribeSession!(
        { threadId: "thread-1", terminalId: "default", acceptScreen: false },
        { screen: () => undefined, event: () => undefined, overflow: () => undefined },
      );
      plain.start();
      yield* Effect.promise(flush);
      expect(process.snapshotRequests).toEqual([]);
      plain.unsubscribe(0);
    }),
  );

  it.effect("never spawns for attachOnly", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      const { manager } = yield* makeHostManager(adapter);
      const missing = yield* manager.open(openInput({ attachOnly: true })).pipe(Effect.flip);
      expect(missing._tag).toBe("TerminalNotRunningError");
      expect(adapter.spawnInputs).toEqual([]);

      yield* manager.open(openInput());
      (adapter.processes[0] as FakeHostProcess).emitExit({ exitCode: 0, signal: null });
      yield* Effect.promise(flush);
      const exited = yield* manager.open(openInput({ attachOnly: true }));
      expect(exited.status).toBe("exited");
      expect(adapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("reattaches after a backend restart and sends a screen item first", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      const first = yield* makeHostManager(adapter);
      yield* first.manager.open(openInput());
      const process = adapter.processes[0] as FakeHostProcess;
      process.emitHost("before restart");
      yield* writeHistory(first.logsDir);

      // A new backend over the same state: the view subscribes before it reopens the pane.
      const second = yield* makeHostManager(adapter, { logsDir: first.logsDir });
      const view = yield* subscribeView(second.manager);
      const reopened = yield* second.manager.open(openInput({ attachOnly: true }));
      yield* Effect.promise(flush);
      expect(adapter.spawnInputs.at(-1)).toMatchObject({ recoverOnly: true });
      expect(reopened.pid).toBe(process.pid);
      expect(view.texts()[0]).toBe("[screen 1]");
      process.emitHost("after");
      yield* Effect.promise(flush);
      expect(view.texts()).toEqual(["[screen 1]", "after"]);
    }),
  );

  it.effect("marks a PTY whose host went away host-lost and serves its cold screen", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      const { manager } = yield* makeHostManager(adapter);
      const notices: TerminalLifecycleNotice[] = [];
      yield* manager.subscribeLifecycle!((notice) => Effect.sync(() => notices.push(notice)));
      yield* manager.open(openInput());
      const process = adapter.processes[0] as FakeHostProcess;
      process.interruptionReason = "remote-service-restarted";
      process.emitExit({ exitCode: 0, signal: null });
      yield* Effect.promise(flush);

      const snapshot = yield* manager.snapshot({ threadId: "thread-1", terminalId: "default" });
      expect(snapshot).toMatchObject({
        status: "exited",
        endedReason: "host-lost",
        restorable: false,
      });
      expect(notices.map((notice) => notice.kind)).toEqual(["hostLost"]);

      adapter.generations.cold = {
        ...(yield* Effect.promise(() => process.screen.snapshot({ attachRenderer: false }))),
        modelState: "cold",
      };
      const view = yield* subscribeView(manager);
      yield* Effect.promise(flush);
      expect(view.texts()).toEqual(["[screen 0 cold]"]);
    }),
  );

  it.effect("lists host-owned panes in the inventory and opens a lost one read-only", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      const ownerKey = `terminal:${JSON.stringify(["thread-1", "lost-pane"])}`;
      adapter.ownership.rows.set(ownerKey, {
        ...profileOwner(),
        ownerKey,
        target: "local-terminal-host",
        resourceId: "pty-lost",
        state: "may-have-been-sent",
      });
      const liveKey = `terminal:${JSON.stringify(["thread-2", "live"])}`;
      adapter.ownership.rows.set(liveKey, {
        ...profileOwner(),
        ownerKey: liveKey,
        target: "local-terminal-host",
        resourceId: "pty-live",
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
        {
          ptyId: "pty-live",
          connectionId: "state-1",
          state: "running",
          lost: false,
          activityState: "busy",
          lifecycleManaged: true,
        },
      ];
      const { manager } = yield* makeHostManager(adapter);
      const inventories: TerminalSessionInventory[] = [];
      yield* manager.subscribe(() => Effect.void, {
        onInventory: (inventory) => Effect.sync(() => inventories.push(inventory)),
      });
      expect(inventories[0]?.sessions).toEqual([
        // A lost PTY stays a member (read-only last screen) but is not a running terminal.
        { threadId: "thread-1", terminalId: "lost-pane", live: false, activity: "quiet" },
        { threadId: "thread-2", terminalId: "live", activity: "busy" },
      ]);

      const lost = yield* manager.open(openInput({ terminalId: "lost-pane", attachOnly: true }));
      expect(lost).toMatchObject({
        status: "exited",
        endedReason: "host-lost",
        screenSource: "host",
      });
      expect(adapter.spawnInputs).toEqual([]);
    }),
  );
});
