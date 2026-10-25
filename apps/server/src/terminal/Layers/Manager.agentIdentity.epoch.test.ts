import { Deferred, Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import { createTerminalAgentDetector, parsePosixAgentProcesses } from "./Manager.agentDetection.ts";
import { pollAgentIdentityWith } from "./Manager.process-drain.identity.ts";
import { createTerminalSessionState } from "./Manager.session.state.ts";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle.ts";
import type { TerminalManagerState } from "./Manager.types.ts";
import { toSessionKey } from "./Manager.shell.ts";

it("rejects an in-flight generic scan from an older runtime epoch even when the PID is reused", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = Object.assign(
        createTerminalSessionState({
          threadId: "thread",
          terminalId: "main",
          executionTargetId: "local",
          dropPathMode: "posix",
          cwd: process.cwd(),
          worktreePath: null,
          history: "",
          cols: 80,
          rows: 24,
          runtimeEnv: null,
        }),
        { status: "running" as const, pid: 100 },
      );
      let state: TerminalManagerState = {
        sessions: new Map([[toSessionKey(session.threadId, session.terminalId), session]]),
        killFibers: new Map(),
      };
      const events: TerminalEvent[] = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const detector = createTerminalAgentDetector({
        agents: [{ id: "nebula", names: ["Nebula Worker"], executables: ["nebula-worker"] }],
        inspect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return {
              platform: "posix" as const,
              processes: parsePosixAgentProcesses(
                "100 1 100 200 /bin/zsh\n200 100 200 200 nebula-worker",
              ),
            };
          }),
      });
      const ctx = {
        agentDetector: detector,
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
      const scan = yield* Effect.forkChild(pollAgentIdentityWith(ctx, [session]));
      yield* Deferred.await(started);
      session.runtimeEpoch++;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(scan);
      expect(events).toEqual([]);
      expect(session.activeAgent).toBeNull();
      expect(session.activeAgentProvider).toBeNull();
    }),
  );
});
