import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { homedir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { TerminalRuntimeLeaseError } from "@bigbud/contracts/workspace/terminal.ts";
import {
  createManager,
  FakePtyAdapter,
  makeDirectory,
  openInput,
  waitFor,
} from "./Manager.test.helpers";
import { makeTerminalManagerWithOptions } from "./Manager.process";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "terminal startup and ownership",
  (it) => {
    it.effect(
      "keeps manual cd, process, and output independent of later chat cwd, env, and target",
      () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter, baseDir, getEvents } = yield* createManager();
          const origin = path.join(baseDir, "origin");
          const updated = path.join(baseDir, "updated");
          yield* makeDirectory(origin);
          yield* makeDirectory(updated);
          const original = yield* manager.open(openInput({ cwd: origin, env: { ROOT: origin } }));
          yield* manager.write({
            threadId: "thread-1",
            terminalId: "default",
            data: "cd /manual\n",
          });
          ptyAdapter.processes[0]!.emitData("manual output\r\n");
          yield* waitFor(
            Effect.map(getEvents, (events) => events.some((event) => event.type === "output")),
          );
          const attached = yield* manager.open(
            openInput({
              cwd: "/missing/new-worktree",
              executionTargetId: "ssh:unreachable",
              env: { ROOT: updated },
            }),
          );
          expect(attached.pid).toBe(original.pid);
          expect(attached.cwd).toBe(origin);
          expect(attached.runtimeEnv).toEqual({ ROOT: origin });
          expect(attached.history).toContain("manual output");
          expect(ptyAdapter.spawnInputs).toHaveLength(1);
          expect(ptyAdapter.processes[0]?.writes).toEqual(["cd /manual\n"]);
          expect(ptyAdapter.processes[0]?.killed).toBe(false);
          const next = yield* manager.open(
            openInput({ terminalId: "explicit-new", cwd: updated, env: { ROOT: updated } }),
          );
          expect(next.cwd).toBe(updated);
          expect(next.runtimeEnv).toEqual({ ROOT: updated });
          expect(ptyAdapter.spawnInputs[1]?.env.ROOT).toBe(updated);
        }),
    );

    it.effect("does not treat lease reservation failure as a folder failure or spawn a PTY", () =>
      Effect.gen(function* () {
        let leases = 0;
        const fs = yield* FileSystem.FileSystem;
        const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-terminal-lease-" });
        const ptyAdapter = new FakePtyAdapter();
        const manager = yield* makeTerminalManagerWithOptions({
          logsDir,
          ptyAdapter,
          acquireWorktreeLease: (input) => {
            leases++;
            return Effect.fail(
              new TerminalRuntimeLeaseError({ cwd: input.cwd, reason: "unknown" }),
            );
          },
        });
        const failure = yield* Effect.flip(manager.open(openInput()));
        expect(failure._tag).toBe("TerminalRuntimeLeaseError");
        expect(leases).toBe(1);
        expect(ptyAdapter.spawnInputs).toHaveLength(0);
      }),
    );

    it.effect("uses Home for both surfaces and never inherits project setup metadata there", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, baseDir } = yield* createManager();
        const missing = path.join(baseDir, "missing");
        for (const terminalId of ["default", "independent-panel"]) {
          const snapshot = yield* manager.open(
            openInput({
              terminalId,
              cwd: missing,
              worktreePath: missing,
              env: { SETUP_ROOT: missing },
            }),
          );
          expect(snapshot.cwd).toBe(homedir());
          expect(snapshot.worktreePath).toBeNull();
          expect(snapshot.runtimeEnv).toEqual({});
          expect(snapshot.directoryFallback?.requestedCwd).toBe(missing);
        }
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        expect(
          ptyAdapter.spawnInputs.every(
            (input) => input.cwd === homedir() && input.env.SETUP_ROOT === undefined,
          ),
        ).toBe(true);
      }),
    );
  },
);
