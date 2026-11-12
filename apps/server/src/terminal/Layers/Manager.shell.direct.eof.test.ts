import * as Effect from "effect/Effect";
import { expect, it, vi } from "vitest";
import { createTerminalSessionState } from "./Manager.session.state";
import { FakePtyProcess } from "./Manager.test.helpers";
import { drainProcessEventsWith } from "./Manager.process-drain.events";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle";
import { terminalPaneWork } from "./Manager.idleWork";
import { intent } from "./DirectShellLaunch.dispatch.test.helpers";

it("settles old local transport after refused close without treating retained direct ownership as idle", async () => {
  const launch = intent();
  const session = createTerminalSessionState({
    threadId: "t",
    terminalId: "p",
    executionTargetId: launch.executionTargetId,
    dropPathMode: "posix",
    cwd: "/work",
    worktreePath: null,
    history: "retained",
    cols: 80,
    rows: 24,
    runtimeEnv: null,
  });
  const process = new FakePtyProcess(123);
  session.process = process;
  session.pid = process.pid;
  session.status = "error";
  session.shellUnconfirmedLaunch = {
    status: "unconfirmed",
    requestedProfile: launch.launch.requestedProfile,
  };
  session.restartPreparation = vi.fn().mockRejectedValue(new Error("old unsupported hook"));
  session.pendingProcessEvents = [{ type: "exit", event: { exitCode: 0, signal: null } }];
  const publishEvent = vi.fn(() => Effect.void);
  await Effect.runPromise(
    drainProcessEventsWith(
      {
        publishEvent,
        evictInactiveSessionsIfNeeded: () => Effect.void,
      } as unknown as ProcessLifecycleContext,
      () => Effect.void,
      session,
      process.pid,
    ),
  );
  expect(session.status).toBe("exited");
  expect(session.process).toBeNull();
  expect(session.restartPreparation).toBeUndefined();
  expect(session.shellUnconfirmedLaunch).toBeDefined();
  expect(session.history).toBe("retained");
  expect(terminalPaneWork(session)).toBe("unknown");
  expect(publishEvent).toHaveBeenCalledOnce();
});
