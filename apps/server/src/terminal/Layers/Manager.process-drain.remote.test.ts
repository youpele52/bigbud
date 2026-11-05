import { Deferred, Effect, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import {
  parsePosixAgentProcesses,
  TerminalAgentInspectionError,
} from "./Manager.agentDetection.ts";
import { pollSubprocessActivityWith } from "./Manager.process-drain.poll.ts";
import { createTerminalSessionState } from "./Manager.session.state.ts";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle.ts";
import type { TerminalManagerState, TerminalSessionState } from "./Manager.types.ts";
import { toSessionKey } from "./Manager.shell.ts";
import { FakePtyProcess } from "./Manager.test.helpers.ts";

const target = "ssh:host=devbox&auth=ssh-key";
function session(
  id: string,
  executionTargetId: string,
  pid: number,
  remotePid?: number,
): TerminalSessionState & { pid: number } {
  return Object.assign(
    createTerminalSessionState({
      threadId: "thread",
      terminalId: id,
      executionTargetId,
      dropPathMode: "posix",
      cwd: "/project",
      worktreePath: null,
      history: "",
      cols: 80,
      rows: 24,
      runtimeEnv: null,
    }),
    { status: "running" as const, pid, remoteShellPid: remotePid },
  );
}
function fixture(sessions: Array<TerminalSessionState & { pid: number }>) {
  let state: TerminalManagerState = {
    sessions: new Map(
      sessions.map((value) => [toSessionKey(value.threadId, value.terminalId), value]),
    ),
    killFibers: new Map(),
  };
  const events: TerminalEvent[] = [];
  const agentDetector = vi.fn(() => Effect.succeed(new Map()));
  const subprocessChecker = vi.fn(() => Effect.succeed(false));
  const remoteProcessInspector = vi.fn(() =>
    Effect.succeed(
      parsePosixAgentProcesses(
        "100 1 100 200 /bin/zsh\n200 100 200 200 gemini\n9000 1 9000 300 /bin/bash\n300 9000 300 300 codex",
      ),
    ),
  );
  const ctx = {
    readManagerState: Effect.sync(() => state),
    agentDetector,
    subprocessChecker,
    remoteProcessInspector,
    modifyManagerState: (
      f: (state: TerminalManagerState) => readonly [unknown, TerminalManagerState],
    ) =>
      Effect.sync(() => {
        const [value, next] = f(state);
        state = next;
        return value;
      }),
    publishEvent: (event: TerminalEvent) =>
      Effect.sync(() => {
        events.push(event);
      }),
  } as unknown as ProcessLifecycleContext;
  return { ctx, events, agentDetector, subprocessChecker, remoteProcessInspector };
}

it("batches per target and isolates local, Direct SSH and agent-backed PID spaces (including collisions)", async () => {
  const local = session("local", "local", 100);
  const direct = session("direct", target, 9000, 100);
  const agent = session("agent", target, 9000);
  agent.process = Object.assign(new FakePtyProcess(9000), { pidDomain: "remote" as const });
  const other = session("other", target + "&user=other", 9001, 100);
  const unknown = session("no-remote-pid", target, 9999);
  const f = fixture([local, direct, agent, other, unknown]);
  await Effect.runPromise(pollSubprocessActivityWith(f.ctx));
  expect(f.agentDetector).toHaveBeenCalledExactlyOnceWith([100]);
  expect(f.subprocessChecker).toHaveBeenCalledExactlyOnceWith(100);
  expect(f.remoteProcessInspector).toHaveBeenCalledTimes(2);
  expect(direct.activeAgent).toEqual({ id: "gemini", names: ["Gemini", "Gemini CLI"] });
  expect(direct.activeAgentProvider).toBeNull();
  expect(agent.activeAgentProvider).toBe("codex");
  expect(unknown.activeAgent).toBeNull();
  expect(f.events.filter((event) => event.type === "activity")).toHaveLength(3);
});

it("keeps identity on transient failures/missing roots and clears only after confirmed idle scans", async () => {
  const direct = session("direct", target, 9000, 100);
  const f = fixture([direct]);
  await Effect.runPromise(pollSubprocessActivityWith(f.ctx));
  f.ctx.remoteProcessInspector = () =>
    Effect.fail(new TerminalAgentInspectionError({ message: "offline" }));
  for (let i = 0; i < 3; i++) await Effect.runPromise(pollSubprocessActivityWith(f.ctx));
  expect(direct.activeAgent?.id).toBe("gemini");
  f.ctx.remoteProcessInspector = () => Effect.succeed(parsePosixAgentProcesses("1 0 1 -1 init"));
  await Effect.runPromise(pollSubprocessActivityWith(f.ctx));
  expect(direct.activeAgent?.id).toBe("gemini");
  f.ctx.remoteProcessInspector = () =>
    Effect.succeed(parsePosixAgentProcesses("100 1 100 100 /bin/zsh"));
  await Effect.runPromise(pollSubprocessActivityWith(f.ctx));
  expect(direct.activeAgent?.id).toBe("gemini");
  await Effect.runPromise(pollSubprocessActivityWith(f.ctx));
  expect(direct.activeAgent).toBeNull();
  expect(direct.hasRunningSubprocess).toBe(false);
});

for (const change of ["epoch", "generation", "exit", "target"] as const) {
  it(`rejects stale remote identity AND activity after ${change}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const direct = session("direct", target, 9000, 100);
        const f = fixture([direct]);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.ctx.remoteProcessInspector = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return parsePosixAgentProcesses("100 1 100 200 /bin/zsh\n200 100 200 200 codex");
          });
        const scan = yield* Effect.forkChild(pollSubprocessActivityWith(f.ctx));
        yield* Deferred.await(started);
        if (change === "epoch") direct.runtimeEpoch++;
        if (change === "generation") direct.runtimeGeneration += "-new";
        if (change === "exit") direct.status = "exited";
        if (change === "target") direct.executionTargetId += "&user=changed";
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(scan);
        expect(f.events).toEqual([]);
        expect(direct.activeAgent).toBeNull();
        expect(direct.hasRunningSubprocess).toBe(false);
      }),
    );
  });
}

it("bounds concurrent target probes to four independently of pane/project count", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = Array.from({ length: 9 }, (_, index) =>
        session(String(index), `${target}&user=user${index}`, 9000 + index, 100),
      );
      const f = fixture(sessions);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      f.ctx.remoteProcessInspector = () =>
        Effect.gen(function* () {
          active++;
          maximum = Math.max(maximum, active);
          if (active === 4) yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          active--;
          return parsePosixAgentProcesses("100 1 100 100 /bin/sh");
        });
      const poll = yield* Effect.forkChild(pollSubprocessActivityWith(f.ctx));
      yield* Deferred.await(started);
      expect(active).toBe(4);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(poll);
      expect(maximum).toBe(4);
    }),
  );
});
