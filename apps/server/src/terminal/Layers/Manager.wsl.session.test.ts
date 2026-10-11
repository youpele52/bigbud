import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vitest";
import { homedir } from "node:os";
import { wslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { resolveWslTerminalFolder } from "./Manager.wsl";
import { createManager, openInput, restartInput } from "./Manager.test.helpers";
import * as Deferred from "effect/Deferred";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  OrchestrationDispatchCommandError,
  ThreadId,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { makeDispatchShellCommand } from "../../ws/wsShellDispatch";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault.ts";

vi.mock("./Manager.wsl", () => ({ resolveWslTerminalFolder: vi.fn() }));
const identity = { distribution: "Ubuntu dev", username: "alice", uid: 1000 };
const folder = {
  cwd: "/mapped/worktree",
  worktreePath: "/mapped/worktree",
  env: { T3CODE_PROJECT_ROOT: "/mapped/project", T3CODE_WORKTREE_PATH: "/mapped/worktree" },
  wslIdentity: identity,
};

it.layer(NodeServices.layer, { excludeTestServices: true })("WSL terminal sessions", (it) => {
  it.effect(
    "snapshot and PTY preserve explicit identity, cwd and translated env; only restart changes it",
    () =>
      Effect.gen(function* () {
        vi.mocked(resolveWslTerminalFolder).mockReturnValue(Effect.succeed(folder));
        const { manager, ptyAdapter } = yield* createManager();
        const target = wslTerminalTargetId(identity.distribution);
        const opened = yield* manager.open(
          openInput({
            executionTargetId: target,
            cwd: "C:\\project",
            worktreePath: "C:\\worktree",
            env: { T3CODE_PROJECT_ROOT: "C:\\project" },
          }),
        );
        expect(opened).toMatchObject({
          cwd: folder.cwd,
          worktreePath: folder.worktreePath,
          wslIdentity: identity,
          runtimeEnv: folder.env,
          executionTargetId: target,
        });
        expect(ptyAdapter.spawnInputs[0]).toMatchObject({
          cwd: homedir(),
          executionTargetId: target,
        });
        expect(ptyAdapter.spawnInputs[0]?.remoteCwd).toBeUndefined();
        expect(isRemoteAgentExecutionTarget(target)).toBe(false);
        expect(ptyAdapter.spawnInputs[0]?.args?.slice(0, 4)).toEqual([
          "--distribution",
          "Ubuntu dev",
          "--user",
          "alice",
        ]);
        expect(ptyAdapter.spawnInputs[0]?.args).toContain("T3CODE_PROJECT_ROOT=/mapped/project");
        expect(ptyAdapter.spawnInputs[0]?.args).toContain("/mapped/worktree");
        expect(
          (yield* manager.snapshot({ threadId: opened.threadId, terminalId: opened.terminalId }))
            .wslIdentity,
        ).toEqual(identity);
        const calls = vi.mocked(resolveWslTerminalFolder).mock.calls.length;
        const retained = yield* manager.open(
          openInput({ executionTargetId: wslTerminalTargetId("Other"), cwd: "/ignored" }),
        );
        expect(retained.wslIdentity).toEqual(identity);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect(resolveWslTerminalFolder).toHaveBeenCalledTimes(calls);
        vi.mocked(resolveWslTerminalFolder).mockReturnValue(
          Effect.succeed({
            ...folder,
            wslIdentity: { ...identity, distribution: "Other", username: "bob", uid: 1001 },
          }),
        );
        const restarted = yield* manager.restart(
          restartInput({ executionTargetId: wslTerminalTargetId("Other"), cwd: "/other" }),
        );
        expect(restarted.wslIdentity?.username).toBe("bob");
        expect(ptyAdapter.spawnInputs[1]?.args?.slice(0, 4)).toEqual([
          "--distribution",
          "Other",
          "--user",
          "bob",
        ]);
      }),
  );
  it.effect("resolution failure cannot start a PTY or mutate a retained session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const error = new TerminalExecutionTargetError({
        threadId: "x",
        terminalId: "x",
        executionTargetId: "wsl:missing",
        detail: "Target unavailable",
      });
      vi.mocked(resolveWslTerminalFolder).mockReturnValue(Effect.fail(error));
      const result = yield* Effect.result(
        manager.open(openInput({ executionTargetId: "wsl:missing" })),
      );
      expect(result._tag).toBe("Failure");
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
      vi.mocked(resolveWslTerminalFolder).mockReturnValue(Effect.succeed(folder));
      const active = yield* manager.open(openInput({ executionTargetId: "wsl:Ubuntu%20dev" }));
      vi.mocked(resolveWslTerminalFolder).mockReturnValue(Effect.fail(error));
      const restarted = yield* Effect.result(
        manager.restart(restartInput({ executionTargetId: "wsl:missing" })),
      );
      expect(restarted._tag).toBe("Failure");
      expect(ptyAdapter.processes[0]?.killed).toBe(false);
      expect(
        (yield* manager.snapshot({ threadId: active.threadId, terminalId: active.terminalId }))
          .wslIdentity,
      ).toEqual(identity);
    }),
  );
  it.effect(
    "first ! send uses its independent workspace shell even with an active manual WSL terminal",
    () =>
      Effect.gen(function* () {
        vi.mocked(resolveWslTerminalFolder).mockReturnValue(Effect.succeed(folder));
        const { manager, ptyAdapter } = yield* createManager();
        const threadId = ThreadId.makeUnsafe("shell-in-wsl-chat");
        yield* manager.open(
          openInput({ threadId, executionTargetId: "wsl:Ubuntu%20dev", cwd: "C:\\project" }),
        );
        const ran = yield* Deferred.make<void>();
        const run = vi.fn((request: { cwd: string }) =>
          Deferred.succeed(ran, undefined).pipe(Effect.as({ output: request.cwd, exitCode: 0 })),
        );
        const readModel = {
          projects: [{ id: "project", workspaceRoot: homedir(), executionTargetId: "local" }],
          threads: [
            {
              id: threadId,
              projectId: "project",
              executionTargetId: "local",
              workspaceExecutionTargetId: "local",
              worktreePath: null,
              branch: null,
            },
          ],
          checkpointRefs: [],
          updatedAt: "now",
        } as unknown as OrchestrationReadModel;
        const dispatch = makeDispatchShellCommand({
          enqueueCommand: (effect) => effect,
          dispatchInitialShellCommand: () => Effect.succeed({ sequence: 1 }),
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 1 }),
            getReadModel: () => Effect.succeed(readModel),
          },
          serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
          threadShellRunner: { run, closeThread: () => Effect.void },
          serverCommandId: (tag) => CommandId.makeUnsafe(`server:${tag}`),
          toDispatchCommandError: (cause, fallbackMessage) =>
            new OrchestrationDispatchCommandError({ message: fallbackMessage, cause }),
        });
        yield* dispatch({
          type: "thread.shell.run",
          commandId: CommandId.makeUnsafe("shell"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("message"),
            role: "user",
            text: "!pwd",
            attachments: [],
          },
          shellCommand: "pwd",
          createdAt: new Date().toISOString(),
        });
        yield* Deferred.await(ran);
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({ cwd: homedir(), command: "pwd" }),
        );
        expect(ptyAdapter.processes[0]?.writes).toEqual([]);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect((yield* manager.snapshot({ threadId, terminalId: "default" })).wslIdentity).toEqual(
          identity,
        );
      }),
  );
});
