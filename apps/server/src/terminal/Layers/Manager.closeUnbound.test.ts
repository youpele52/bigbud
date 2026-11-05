import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect } from "vitest";
import {
  createManager,
  openInput,
  multiTerminalHistoryLogPath,
  pathExists,
  writeFileString,
} from "./Manager.test.helpers";
import { makeTerminalClose } from "./Manager.session.close";
import { createTerminalSessionState } from "./Manager.session.state";
import type { SessionApiContext } from "./Manager.session.types";

const request = { threadId: "thread-1", terminalId: "default", onlyIfNotRunning: true };
it.layer(NodeServices.layer, { excludeTestServices: true })("identityless terminal close", (it) => {
  it.effect("acknowledges an absent pane without spawning a shell", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.close(request);
      expect(ptyAdapter.processes).toHaveLength(0);
    }),
  );
  it.effect("removes a definitively failed launch", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      ptyAdapter.spawnFailures.push(new Error("launch failed"));
      const failed = yield* manager.open(openInput());
      expect(failed.status).toBe("error");
      yield* manager.close(request);
      expect(ptyAdapter.processes).toHaveLength(0);
      expect((yield* manager.snapshot(openInput()).pipe(Effect.result))._tag).toBe("Failure");
    }),
  );
  it.effect("refuses an unidentified live process without signaling it", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const opened = yield* manager.open(openInput());
      for (const closeRequest of [
        request,
        { threadId: request.threadId, onlyIfNotRunning: true },
      ]) {
        expect((yield* manager.close(closeRequest).pipe(Effect.result))._tag).toBe("Failure");
      }
      expect(ptyAdapter.processes[0]!.killSignals).toEqual([]);
      expect((yield* manager.snapshot(openInput())).pid).toBe(opened.pid);
    }),
  );
  for (const fence of ["remoteOwnerRecoveryRequired", "restartPreparation"] as const) {
    it.effect(`retains an unresolved ${fence} fence`, () =>
      Effect.gen(function* () {
        const session = createTerminalSessionState({
          threadId: request.threadId,
          terminalId: request.terminalId,
          executionTargetId: "ssh:host",
          dropPathMode: "posix",
          cwd: "/project",
          worktreePath: null,
          history: "",
          cols: 80,
          rows: 24,
          runtimeEnv: null,
        });
        if (fence === "remoteOwnerRecoveryRequired") session.remoteOwnerRecoveryRequired = true;
        else session.restartPreparation = async () => undefined;
        let stopped = false;
        const close = makeTerminalClose({
          withThreadLock: (_threadId: string, effect: Effect.Effect<unknown>) => effect,
          getSession: () => Effect.succeed(Option.some(session)),
          stopProcess: () =>
            Effect.sync(() => {
              stopped = true;
            }),
        } as unknown as SessionApiContext);
        expect((yield* close(request).pipe(Effect.result))._tag).toBe("Failure");
        expect(stopped).toBe(false);
      }),
    );
  }
  it.effect("refuses matching-generation Close after owner recovery fails", () =>
    Effect.gen(function* () {
      let released = 0;
      const { manager, logsDir, ptyAdapter } = yield* createManager(5, {
        releaseWorktreeLease: () =>
          Effect.sync(() => {
            released++;
          }),
      });
      const history = multiTerminalHistoryLogPath(logsDir);
      yield* writeFileString(history, "previous owner recovery marker");
      ptyAdapter.spawnFailures.push(new Error("recovery unavailable"));
      const failed = yield* manager.open(openInput());
      expect(failed.status).toBe("error");
      const beforeClose = released;
      const error = yield* manager
        .close({
          threadId: failed.threadId,
          terminalId: failed.terminalId,
          expectedGeneration: failed.runtimeGeneration,
          deleteHistory: true,
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("TerminalExecutionTargetError");
      expect(released).toBe(beforeClose);
      expect(yield* pathExists(history)).toBe(true);
    }),
  );
  it.effect("allows confirmed Close after successful ownership recovery", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      yield* writeFileString(multiTerminalHistoryLogPath(logsDir), "recovery marker");
      const opened = yield* manager.open(openInput());
      yield* manager.close({
        threadId: opened.threadId,
        terminalId: opened.terminalId,
        expectedGeneration: opened.runtimeGeneration,
      });
    }),
  );
  it.effect("retains a persisted owner marker and lease when the session map is empty", () =>
    Effect.gen(function* () {
      let released = 0;
      const { manager, logsDir, ptyAdapter } = yield* createManager(5, {
        releaseWorktreeLease: () =>
          Effect.sync(() => {
            released++;
          }),
      });
      const history = multiTerminalHistoryLogPath(logsDir);
      yield* writeFileString(history, "previous remote terminal output");
      for (const closeRequest of [
        request,
        { threadId: request.threadId, onlyIfNotRunning: true },
        { ...request, onlyIfNotRunning: false, expectedGeneration: "before-server-crash" },
      ]) {
        const result = yield* manager
          .close({ ...closeRequest, deleteHistory: true })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* pathExists(history)).toBe(true);
        expect(released).toBe(0);
        expect(ptyAdapter.processes).toHaveLength(0);
      }
    }),
  );
});
