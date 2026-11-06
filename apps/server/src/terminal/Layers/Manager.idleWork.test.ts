import { describe, expect, it, vi } from "vitest";
import { Effect, SynchronizedRef } from "effect";
import { makeManagerStateAccessors } from "./Manager.process.state.ts";
import { makeInactiveSessionEviction } from "./Manager.process.eviction.ts";
import {
  makeTerminalIdleWorkTracker,
  terminalPaneWork,
  terminalWorkAllowsIdle,
  invalidateTerminalWorkAssessment,
} from "./Manager.idleWork.ts";
import { createTerminalSessionState } from "./Manager.session.state.ts";
import { FakePtyProcess } from "./Manager.test.helpers.ts";
import { toSessionKey } from "./Manager.shell.ts";
import type { TerminalManagerState } from "./Manager.types.ts";

const pane = (terminalId = "one", threadId = "thread") => {
  const session = createTerminalSessionState({
    threadId,
    terminalId,
    executionTargetId: "local",
    dropPathMode: "posix",
    cwd: "/tmp",
    worktreePath: null,
    history: "",
    cols: 80,
    rows: 24,
    runtimeEnv: null,
  });
  session.status = "running";
  session.process = new FakePtyProcess(9000);
  session.pid = 9000;
  return session;
};
const assess = (session: ReturnType<typeof pane>) => {
  session.subprocessAssessedGeneration = session.runtimeGeneration;
  session.subprocessAssessedEpoch = session.runtimeEpoch;
};

describe("server-owned terminal idle facts", () => {
  it("distinguishes initial/failed assessment, shell, background child, and generic harness", () => {
    const session = pane();
    expect(terminalPaneWork(session)).toBe("unknown");
    assess(session);
    expect(terminalPaneWork(session)).toBe("idle");
    session.hasRunningSubprocess = true;
    expect(terminalPaneWork(session)).toBe("busy");
    session.subprocessAssessedGeneration = undefined;
    expect(terminalPaneWork(session)).toBe("busy");
    session.hasRunningSubprocess = false;
    session.activeAgent = { id: "opencode", names: ["OpenCode"] };
    expect(terminalPaneWork(session)).toBe("busy");
    session.activeAgent = { id: "pi", names: ["Pi"] };
    expect(terminalPaneWork(session)).toBe("busy");
    session.process = null;
    session.status = "exited";
    expect(terminalPaneWork(session)).toBe("idle"); // exited identities never revive work
  });

  it("starts a fresh window only after the final pane ends and retains it after close", () => {
    let now = 100;
    const tracker = makeTerminalIdleWorkTracker(() => now);
    const first = pane();
    const second = pane("two");
    const other = pane("other", "other-thread");
    for (const session of [first, second, other]) assess(session);
    first.hasRunningSubprocess = second.hasRunningSubprocess = true;
    tracker.refresh([first, second, other]);
    expect(tracker.get("thread").state).toBe("busy");
    expect(tracker.get("other-thread").state).toBe("idle");
    first.hasRunningSubprocess = false;
    now = 200;
    tracker.refresh([first, second, other]);
    expect(tracker.get("thread").quietSince).toBeNull();
    second.hasRunningSubprocess = false;
    now = 300;
    tracker.refresh([first, second, other]);
    expect(tracker.get("thread")).toEqual({ state: "idle", quietSince: 300 });
    now = 500;
    tracker.refresh([]);
    expect(tracker.get("thread").quietSince).toBe(300);
    expect(terminalWorkAllowsIdle(tracker.get("thread"), 299)).toBe(false);
    expect(terminalWorkAllowsIdle(tracker.get("thread"), 300)).toBe(true);
    tracker.forget("thread");
    expect(tracker.get("thread").quietSince).toBeNull();
  });

  it("restart, reconnect, unresolved ownership and failed shutdown never create an eligible gap", () => {
    const session = pane();
    assess(session);
    for (const flag of [
      "restartPending",
      "stopPending",
      "lifecyclePending",
      "remoteOwnerRecoveryRequired",
    ] as const) {
      session[flag] = true;
      expect(terminalPaneWork(session)).toBe("unknown");
      session[flag] = false;
    }
    session.runtimeGeneration = "replacement";
    expect(terminalPaneWork(session)).toBe("unknown");
    assess(session);
    session.status = "error";
    expect(terminalPaneWork(session)).toBe("unknown");
    session.process = null;
    session.restartPreparation = async () => {};
    expect(terminalPaneWork(session)).toBe("unknown");
  });

  it.each([
    "remoteOwnerRecoveryRequired",
    "restartPreparation",
    "restartPending",
    "stopPending",
    "lifecyclePending",
  ] as const)("retains inactive uncertainty during eviction: %s", async (flag) => {
    const session = pane();
    session.status = "error";
    session.process = null;
    if (flag === "restartPreparation") session.restartPreparation = async () => {};
    else session[flag] = true;
    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* SynchronizedRef.make<TerminalManagerState>({
          sessions: new Map([[toSessionKey(session.threadId, session.terminalId), session]]),
          killFibers: new Map(),
        });
        const access = makeManagerStateAccessors(ref);
        const evict = makeInactiveSessionEviction(access.modifyManagerState, 0);
        yield* evict();
        const retained = yield* access.sessionsForThread(session.threadId);
        expect(retained).toEqual([session]);
        const tracker = makeTerminalIdleWorkTracker();
        tracker.refresh(retained);
        expect(tracker.get(session.threadId).state).toBe("unknown");
        if (flag === "restartPreparation") session.restartPreparation = undefined;
        else session[flag] = false;
        yield* evict();
        expect(yield* access.sessionsForThread(session.threadId)).toEqual([]);
      }),
    );
  });

  it("bounds completion retention by the longest rule, not the current sweep policy", () => {
    let now = 1;
    const tracker = makeTerminalIdleWorkTracker(() => now);
    const session = pane();
    tracker.refresh([session]);
    assess(session);
    tracker.refresh([session]);
    now += 30 * 24 * 60 * 60_000;
    tracker.refresh([]);
    expect(tracker.get("thread").quietSince).toBe(1);
    now++;
    tracker.refresh([]);
    expect(tracker.get("thread").quietSince).toBeNull();
  });

  it("reuses membership indexing and refreshes only the queried thread's panes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = new Map(
          Array.from({ length: 300 }, (_, index) => {
            const session = pane("one", `thread-${index}`);
            return [toSessionKey(session.threadId, session.terminalId), session] as const;
          }),
        );
        const scans = vi.spyOn(sessions, "values");
        const ref = yield* SynchronizedRef.make<TerminalManagerState>({
          sessions,
          killFibers: new Map(),
        });
        const access = makeManagerStateAccessors(ref);
        const tracker = makeTerminalIdleWorkTracker(() => 100);
        for (let index = 0; index < 300; index++) {
          const id = `thread-${index}`;
          tracker.refreshThread(id, yield* access.sessionsForThread(id));
        }
        expect(scans).toHaveBeenCalledTimes(1);
        const selected = sessions.get(toSessionKey("thread-0", "one"))!;
        assess(selected);
        // Mutated runtime state is visible without rebuilding global membership.
        tracker.refreshThread("thread-0", yield* access.sessionsForThread("thread-0"));
        expect(tracker.get("thread-0")).toEqual({ state: "idle", quietSince: 100 });
        expect(tracker.get("thread-1").state).toBe("unknown");
        expect(scans).toHaveBeenCalledTimes(1);
        yield* access.modifyManagerState((state) => [undefined, { ...state, sessions: new Map() }]);
        tracker.refreshThread("thread-0", yield* access.sessionsForThread("thread-0"));
        expect(tracker.get("thread-0").quietSince).toBe(100);
      }),
    );
  });

  it("fences uncertainty updates against generation, epoch, PID and target changes", async () => {
    const session = pane();
    assess(session);
    const expected = { ...session };
    const state: TerminalManagerState = {
      sessions: new Map([[toSessionKey("thread", "one"), session]]),
      killFibers: new Map(),
    };
    const ctx = {
      modifyManagerState: <A>(
        f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
      ) => Effect.sync(() => f(state)[0]),
    };
    for (const stale of [
      { ...expected, runtimeGeneration: "old" },
      { ...expected, runtimeEpoch: -1 },
      { ...expected, pid: 1 },
      { ...expected, executionTargetId: "other" },
    ]) {
      await Effect.runPromise(invalidateTerminalWorkAssessment(ctx, [stale]));
      expect(session.subprocessAssessedGeneration).toBe(session.runtimeGeneration);
    }
    await Effect.runPromise(invalidateTerminalWorkAssessment(ctx, [expected]));
    expect(terminalPaneWork(session)).toBe("unknown");
  });
});
