import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vitest";
import type { OrchestrationReadModel } from "@bigbud/contracts";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager";
import { ProjectSetupScriptRunner } from "../Services/ProjectSetupScriptRunner";
import { ProjectSetupScriptRunnerLive } from "./ProjectSetupScriptRunner";

describe("setup commands retain workspace target", () => {
  it("does not inject setup into an actual retained manual WSL runtime", async () => {
    const snapshot: TerminalSessionSnapshot = {
      threadId: "thread",
      terminalId: "manual",
      executionTargetId: "wsl:Ubuntu",
      wslIdentity: { distribution: "Ubuntu", username: "alice", uid: 1000 },
      cwd: "/mapped/worktree",
      worktreePath: "/mapped/worktree",
      runtimeEnv: {},
      dropPathMode: "posix",
      status: "running",
      pid: 1,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "now",
    };
    const open = vi.fn(() => Effect.succeed(snapshot));
    const write = vi.fn(() => Effect.void);
    const program = Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner;
      return yield* runner.runForThread({
        threadId: "thread",
        projectId: "project",
        worktreePath: "C:\\worktree",
        preferredTerminalId: "manual",
      });
    }).pipe(
      Effect.provide(
        ProjectSetupScriptRunnerLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(TerminalManager, { open, write } as unknown as TerminalManagerShape),
              Layer.succeed(OrchestrationEngineService, {
                getReadModel: () =>
                  Effect.succeed({
                    projects: [
                      {
                        id: "project",
                        workspaceRoot: "C:\\project",
                        executionTargetId: "local",
                        scripts: [
                          {
                            id: "setup",
                            name: "Setup",
                            command: "setup-command",
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
    await expect(Effect.runPromise(program)).rejects.toThrow("launch context does not match");
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ executionTargetId: "local", cwd: "C:\\worktree" }),
    );
    expect(write).not.toHaveBeenCalled();
  });
});
