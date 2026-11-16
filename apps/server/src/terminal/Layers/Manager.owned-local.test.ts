import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Scope } from "effect";
import { expect, vi } from "vitest";

import { makeTerminalManagerWithOptions } from "./Manager.process.ts";
import { PersistentLocalAdapter } from "./Manager.owned-runtime.test.helpers.ts";
import { historyLogPath, openInput, waitFor } from "./Manager.test.helpers.ts";
import { FakePtyProcess } from "./Manager.test.helpers.ts";
import { cleanupFailedTerminalObserver } from "./Manager.process-drain.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "owned local terminal lifecycle",
  (it) => {
    it.effect(
      "detaches a provisional owned observer on failure and retains normal Node cleanup",
      () =>
        Effect.gen(function* () {
          const detach = vi.fn();
          const kill = vi.fn(() => Effect.void);
          const owned = Object.assign(new FakePtyProcess(19000), { detach });
          yield* cleanupFailedTerminalObserver(owned, kill);
          expect(detach).toHaveBeenCalledOnce();
          expect(kill).not.toHaveBeenCalled();
          const node = new FakePtyProcess(19001);
          yield* cleanupFailedTerminalObserver(node, kill);
          expect(kill).toHaveBeenCalledExactlyOnceWith(node);
        }),
    );

    it.effect("keeps the same-host lease when owned creation or recovery is unresolved", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "owned-local-refusal-" });
        const adapter = new PersistentLocalAdapter();
        const releaseLease = vi.fn(() => Effect.void);
        const manager = yield* makeTerminalManagerWithOptions({
          logsDir,
          ptyAdapter: adapter,
          releaseWorktreeLease: releaseLease,
          subprocessPollIntervalMs: 60_000,
        });
        const opened = yield* manager.open(openInput());
        adapter.processes[0]!.emitData("retained owner\n");
        yield* waitFor(fs.exists(historyLogPath(logsDir)));
        yield* manager.remoteDetach!({
          threadId: opened.threadId,
          terminalId: opened.terminalId,
          expectedGeneration: opened.runtimeGeneration!,
        });
        adapter.blockSpawn = yield* Deferred.make<void>();
        const pending = yield* manager.open(openInput()).pipe(Effect.forkScoped);
        yield* Deferred.await(adapter.blockSpawn);
        yield* Fiber.interrupt(pending);
        expect(adapter.spawnInputs.at(-1)?.recoverOnly).toBe(true);
        expect(releaseLease).not.toHaveBeenCalled();
        const refused = yield* manager
          .close({ threadId: opened.threadId, terminalId: opened.terminalId })
          .pipe(Effect.flip);
        expect(String(refused)).toContain("ownership is unresolved");
        expect(releaseLease).not.toHaveBeenCalled();
        expect(adapter.processes[0]!.killSignals).toEqual([]);
        expect([...adapter.ownership.rows.values()][0]?.state).toBe("may-have-been-sent");
      }),
    );

    it.effect(
      "detaches on backend shutdown, retains the lease/ownership, and cold-attaches from local history",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "owned-local-manager-" });
          const adapter = new PersistentLocalAdapter();
          const releaseLease = vi.fn(() => Effect.void);
          const make = () =>
            makeTerminalManagerWithOptions({
              logsDir,
              ptyAdapter: adapter,
              releaseWorktreeLease: releaseLease,
              subprocessPollIntervalMs: 60_000,
              agentDetector: () => Effect.succeed(new Map()),
              subprocessChecker: () => Effect.succeed(false),
            });
          const firstScope = yield* Scope.make("sequential");
          const first = yield* make().pipe(Effect.provideService(Scope.Scope, firstScope));
          const initial = yield* first.open(openInput());
          const process = adapter.processes[0]!;
          process.emitData("durable history\n");
          yield* waitFor(fs.exists(historyLogPath(logsDir)));
          yield* Scope.close(firstScope, Exit.void);
          expect(adapter.detach).toHaveBeenCalledOnce();
          expect(process.killSignals).toEqual([]);
          expect(releaseLease).not.toHaveBeenCalled();
          expect([...adapter.ownership.rows.values()][0]?.state).toBe("may-have-been-sent");

          const secondScope = yield* Scope.make("sequential");
          const second = yield* make().pipe(Effect.provideService(Scope.Scope, secondScope));
          const restored = yield* second.open(openInput());
          expect(adapter.spawnInputs[1]?.recoverOnly).toBe(true);
          expect(adapter.processes).toHaveLength(1);
          expect(restored.pid).toBe(initial.pid);
          expect(restored.executionTargetId).toBe("local");
          expect(restored.historyUnavailable).toBe(true);
          expect(restored.shellLaunchIdentity).toBeUndefined();
          yield* second.write({ ...openInput(), data: "continued\r" });
          expect(process.writes).toContain("continued\r");
          yield* Scope.close(secondScope, Exit.void);
          expect(adapter.detach).toHaveBeenCalledTimes(2);
          expect(process.killSignals).toEqual([]);
          expect(releaseLease).not.toHaveBeenCalled();
        }),
    );

    it.effect(
      "uses the confirmed process abstraction for explicit Stop and releases the same-host lease",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "owned-local-stop-" });
          const adapter = new PersistentLocalAdapter();
          const releaseLease = vi.fn(() => Effect.void);
          const manager = yield* makeTerminalManagerWithOptions({
            logsDir,
            ptyAdapter: adapter,
            releaseWorktreeLease: releaseLease,
            subprocessPollIntervalMs: 60_000,
          });
          const snapshot = yield* manager.open(openInput());
          const process = adapter.processes[0]!;
          yield* manager.close({
            threadId: snapshot.threadId,
            terminalId: snapshot.terminalId,
            expectedGeneration: snapshot.runtimeGeneration,
          });
          expect(adapter.prepareRestart).toHaveBeenCalledOnce();
          expect(process.killSignals).toEqual([]);
          expect([...adapter.ownership.rows.values()][0]?.state).toBe("terminal");
          expect(releaseLease).toHaveBeenCalledWith({
            threadId: snapshot.threadId,
            terminalId: snapshot.terminalId,
          });
        }),
    );
  },
);
