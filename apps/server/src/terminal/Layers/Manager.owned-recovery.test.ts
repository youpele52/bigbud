import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { expect } from "vitest";

import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { PtySpawnError, type PtySpawnInput } from "../Services/PTY.ts";
import { makeTerminalManagerWithOptions } from "./Manager.process.ts";
import { PersistentLocalAdapter } from "./Manager.owned-runtime.test.helpers.ts";
import { historyLogPath, openInput, pathExists, writeFileString } from "./Manager.test.helpers.ts";
import { ownedTerminalOwnerRouteKey } from "./OwnedPtyRuntime.owner.ts";

// Plain-SSH terminals leave local history but never a durable owned-PTY route.
const LEGACY_HISTORY = "ls\r\nShared connection to 203.0.113.7 closed.\r\n";
const ROUTE = ownedTerminalOwnerRouteKey("thread-1", "default");
const unboundClose = (executionTargetId?: string) => ({
  threadId: "thread-1",
  terminalId: "default",
  deleteHistory: true,
  onlyIfNotRunning: true,
  ...(executionTargetId ? { executionTargetId } : {}),
});

/** Fails the next fresh launch the way a rolled-back owned dispatch does. */
class FailOnceAdapter extends PersistentLocalAdapter {
  failNext = false;
  override spawn(input: PtySpawnInput) {
    if (!this.failNext) return super.spawn(input);
    this.failNext = false;
    this.spawnInputs.push(input);
    return Effect.fail(new PtySpawnError({ adapter: "fixture-owned", message: "launch refused" }));
  }
}

const makeManager = (prefix: string, adapter: PersistentLocalAdapter) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const logsDir = yield* fs.makeTempDirectoryScoped({ prefix });
    const manager = yield* makeTerminalManagerWithOptions({
      logsDir,
      ptyAdapter: adapter,
      subprocessPollIntervalMs: 60_000,
    });
    return { logsDir, manager };
  });

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "owned terminal recovery requires a durable owner",
  (it) => {
    it.effect("starts fresh when retained history has no durable owner route", () =>
      Effect.gen(function* () {
        const adapter = new PersistentLocalAdapter();
        const { logsDir, manager } = yield* makeManager("owned-recovery-legacy-", adapter);
        yield* writeFileString(historyLogPath(logsDir), LEGACY_HISTORY);

        const opened = yield* manager.open(openInput());

        expect(adapter.spawnInputs.map((input) => input.recoverOnly)).toEqual([false]);
        expect(opened.status).toBe("running");
        expect(opened.pid).toBe(19000);
        expect(adapter.ownership.rows.get(ROUTE)?.state).toBe("may-have-been-sent");
      }),
    );

    it.effect("starts fresh when the retained owner route is terminal", () =>
      Effect.gen(function* () {
        const adapter = new PersistentLocalAdapter();
        const { logsDir, manager } = yield* makeManager("owned-recovery-exited-", adapter);
        yield* writeFileString(historyLogPath(logsDir), LEGACY_HISTORY);
        adapter.ownership.rows.set(ROUTE, {
          ...profileOwner(),
          ownerKey: ROUTE,
          state: "terminal",
        });

        const opened = yield* manager.open(openInput());

        expect(adapter.spawnInputs.map((input) => input.recoverOnly)).toEqual([false]);
        expect(opened.status).toBe("running");
      }),
    );

    it.effect("Retry after an unreserved launch failure starts fresh and close is allowed", () =>
      Effect.gen(function* () {
        const adapter = new FailOnceAdapter();
        const { manager } = yield* makeManager("owned-recovery-retry-", adapter);
        adapter.failNext = true;

        const failed = yield* manager.open(openInput());
        expect(failed.status).toBe("error");
        const retried = yield* manager.open(openInput());

        expect(adapter.spawnInputs.map((input) => input.recoverOnly)).toEqual([false, false]);
        expect(retried.status).toBe("running");
        yield* manager.close({
          threadId: retried.threadId,
          terminalId: retried.terminalId,
          expectedGeneration: retried.runtimeGeneration,
        });
      }),
    );

    it.effect("keeps attach-only recovery while a possibly-live owner is retained", () =>
      Effect.gen(function* () {
        const adapter = new PersistentLocalAdapter();
        const { logsDir, manager } = yield* makeManager("owned-recovery-retained-", adapter);
        yield* writeFileString(historyLogPath(logsDir), LEGACY_HISTORY);
        adapter.ownership.rows.set(ROUTE, { ...profileOwner(), ownerKey: ROUTE });

        const first = yield* manager.open(openInput());
        const retried = yield* manager.open(openInput());

        expect(adapter.spawnInputs.map((input) => input.recoverOnly)).toEqual([true, true]);
        expect([first.status, retried.status]).toEqual(["error", "error"]);
        expect(adapter.processes).toHaveLength(0);
        const refused = yield* manager
          .close({ threadId: "thread-1", terminalId: "default" })
          .pipe(Effect.flip);
        expect(String(refused)).toContain("ownership is unresolved");
        expect(adapter.ownership.rows.get(ROUTE)?.state).toBe("may-have-been-sent");
      }),
    );

    it.effect("closes an unbound pane when its target store proves no owner survives", () =>
      Effect.gen(function* () {
        const adapter = new PersistentLocalAdapter();
        const { logsDir, manager } = yield* makeManager("owned-close-legacy-", adapter);
        yield* writeFileString(historyLogPath(logsDir), LEGACY_HISTORY);

        yield* manager.close(unboundClose("local"));

        expect(yield* pathExists(historyLogPath(logsDir))).toBe(false);
        expect(adapter.spawnInputs).toEqual([]);
        // The cleared marker lets the next open start a real session.
        expect((yield* manager.open(openInput())).status).toBe("running");
        expect(adapter.spawnInputs.map((input) => input.recoverOnly)).toEqual([false]);
      }),
    );

    it.effect("refuses an unbound close while a possibly-live owner is retained", () =>
      Effect.gen(function* () {
        const adapter = new PersistentLocalAdapter();
        const { logsDir, manager } = yield* makeManager("owned-close-retained-", adapter);
        yield* writeFileString(historyLogPath(logsDir), LEGACY_HISTORY);
        adapter.ownership.rows.set(ROUTE, { ...profileOwner(), ownerKey: ROUTE });

        const refused = yield* manager.close(unboundClose("local")).pipe(Effect.flip);

        expect(String(refused)).toContain("Previous terminal ownership has not been recovered");
        expect(yield* pathExists(historyLogPath(logsDir))).toBe(true);
        expect(adapter.ownership.rows.get(ROUTE)?.state).toBe("may-have-been-sent");
      }),
    );

    it.effect("still refuses an unbound close that names no target", () =>
      Effect.gen(function* () {
        const adapter = new PersistentLocalAdapter();
        const { logsDir, manager } = yield* makeManager("owned-close-untargeted-", adapter);
        yield* writeFileString(historyLogPath(logsDir), LEGACY_HISTORY);

        const refused = yield* manager.close(unboundClose()).pipe(Effect.flip);

        expect(String(refused)).toContain("Previous terminal ownership has not been recovered");
        expect(yield* pathExists(historyLogPath(logsDir))).toBe(true);
      }),
    );

    it.effect("refuses an unbound close when the target store is unreadable", () =>
      Effect.gen(function* () {
        const adapter = new PersistentLocalAdapter();
        const { logsDir, manager } = yield* makeManager("owned-close-unreadable-", adapter);
        yield* writeFileString(historyLogPath(logsDir), LEGACY_HISTORY);
        const store = adapter.ownership.store as { get: (key: string) => Promise<unknown> };
        store.get = async () => {
          throw new Error("owner store unavailable");
        };

        const refused = yield* manager.close(unboundClose("local")).pipe(Effect.flip);

        expect(String(refused)).toContain("Previous terminal ownership has not been recovered");
        expect(yield* pathExists(historyLogPath(logsDir))).toBe(true);
      }),
    );
  },
);
