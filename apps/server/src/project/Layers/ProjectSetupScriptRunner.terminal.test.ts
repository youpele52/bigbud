import path from "node:path";
import { homedir } from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import type { OrchestrationReadModel } from "@bigbud/contracts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager";
import { makeTerminalManagerWithOptions } from "../../terminal/Layers/Manager.process";
import { FakePtyAdapter } from "../../terminal/Layers/Manager.test.helpers";
import { ProjectSetupScriptRunner } from "../Services/ProjectSetupScriptRunner";
import { ProjectSetupScriptRunnerLive } from "./ProjectSetupScriptRunner";

const makeRunner = (
  manager: TerminalManagerShape,
  workspaceRoot: string,
  executionTargetId = "local",
) =>
  Effect.service(ProjectSetupScriptRunner).pipe(
    Effect.provide(
      ProjectSetupScriptRunnerLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(TerminalManager, manager),
            Layer.succeed(OrchestrationEngineService, {
              getReadModel: () =>
                Effect.succeed({
                  projects: [
                    {
                      id: "project",
                      workspaceRoot,
                      executionTargetId,
                      scripts: [
                        {
                          id: "install",
                          name: "Install",
                          command: "bun install",
                          runOnWorktreeCreate: true,
                        },
                      ],
                    },
                  ],
                } as unknown as OrchestrationReadModel),
              dispatch: () => Effect.die("unused"),
              readEvents: () => Stream.empty,
              readReplay: () => Effect.die("unused"),
              streamDomainEvents: Stream.empty,
            }),
          ),
        ),
      ),
    ),
  );

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "ProjectSetupScriptRunner actual terminal safety",
  (it) => {
    for (const failure of ["missing", "inaccessible", "stalled"] as const) {
      it.effect(
        `does not write setup after ${failure} worktree fallback and keeps Home alive`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const base = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-setup-safety-" });
            const worktree = path.join(base, "worktree");
            if (failure !== "missing") yield* fs.makeDirectory(worktree);
            const primaryStarted = yield* Deferred.make<void>();
            const fileSystem = FileSystem.FileSystem.of({
              ...fs,
              stat: (cwd) =>
                cwd === worktree && failure === "stalled"
                  ? Effect.gen(function* () {
                      yield* Deferred.succeed(primaryStarted, undefined);
                      return yield* Effect.never;
                    })
                  : fs.stat(cwd),
              access: (cwd, options) =>
                cwd === worktree && failure === "inaccessible"
                  ? fs.access(path.join(base, "inaccessible-folder"), options)
                  : fs.access(cwd, options),
            });
            const pty = new FakePtyAdapter();
            const manager = yield* makeTerminalManagerWithOptions({
              logsDir: path.join(base, "logs"),
              ptyAdapter: pty,
              agentDetector: () => Effect.succeed(new Map()),
            }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
            const runner = yield* makeRunner(manager, base);
            const action = Effect.flip(
              runner.runForThread({
                threadId: "thread",
                projectId: "project",
                worktreePath: worktree,
              }),
            );
            const error =
              failure === "stalled"
                ? yield* Effect.gen(function* () {
                    const fiber = yield* action.pipe(Effect.forkChild);
                    yield* Deferred.await(primaryStarted);
                    yield* TestClock.adjust(10_000);
                    return yield* Fiber.join(fiber);
                  }).pipe(Effect.provide(TestClock.layer()))
                : yield* action;
            expect(error.message).toContain("Project commands were not run in the fallback folder");
            const opened = yield* manager.snapshot({
              threadId: "thread",
              terminalId: "setup-install",
            });
            expect(opened).toMatchObject({
              cwd: homedir(),
              worktreePath: null,
              executionTargetId: "local",
              status: "running",
              runtimeEnv: {},
            });
            expect(opened.directoryFallback?.requestedCwd).toBe(worktree);
            expect(opened.directoryFallback?.reason).toContain(
              failure === "stalled"
                ? "10 seconds"
                : failure === "missing"
                  ? "does not exist"
                  : "inaccessible",
            );
            expect(pty.spawnInputs).toHaveLength(1);
            expect(pty.processes[0]?.writes).toEqual([]);
            expect(pty.processes[0]?.killed).toBe(false);
            yield* manager.write({
              threadId: "thread",
              terminalId: "setup-install",
              data: "echo manual\r",
            });
            expect(pty.processes[0]?.writes).toEqual(["echo manual\r"]);
          }),
      );
    }

    for (const mismatch of ["worktree", "target", "environment"] as const) {
      it.effect(
        `rejects a retained setup terminal with a different ${mismatch} without restarting or writing`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const base = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-setup-context-" });
            const worktree = path.join(base, "worktree");
            yield* fs.makeDirectory(worktree);
            const pty = new FakePtyAdapter();
            const manager = yield* makeTerminalManagerWithOptions({
              logsDir: path.join(base, "logs"),
              ptyAdapter: pty,
              agentDetector: () => Effect.succeed(new Map()),
            });
            const origin = mismatch === "worktree" ? base : worktree;
            const original = yield* manager.open({
              threadId: "thread",
              terminalId: "setup-install",
              cwd: origin,
              worktreePath: mismatch === "worktree" ? null : worktree,
              env: {
                T3CODE_PROJECT_ROOT: mismatch === "environment" ? "/old-project" : base,
                T3CODE_WORKTREE_PATH: worktree,
              },
            });
            const runner = yield* makeRunner(
              manager,
              base,
              mismatch === "target" ? "ssh:devbox" : "local",
            );
            const error = yield* Effect.flip(
              runner.runForThread({
                threadId: "thread",
                projectId: "project",
                worktreePath: worktree,
              }),
            );
            expect(error.message).toContain("launch context does not match");
            const attached = yield* manager.snapshot({
              threadId: "thread",
              terminalId: "setup-install",
            });
            expect(attached.pid).toBe(original.pid);
            expect(attached.cwd).toBe(origin);
            expect(pty.spawnInputs).toHaveLength(1);
            expect(pty.processes[0]?.writes).toEqual([]);
            expect(pty.processes[0]?.killed).toBe(false);
          }),
      );
    }
  },
);
