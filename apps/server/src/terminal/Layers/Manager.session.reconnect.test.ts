import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vitest";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type { PtyProcess } from "../Services/PTY";
import type { SessionApiContext } from "./Manager.session.types";
import { makeTerminalOpen } from "./Manager.session.open";
import { createTerminalSessionState } from "./Manager.session.state";

const fixture = Effect.fn("test.terminalReconnectFixture")(function* (
  reconnect: (signal?: AbortSignal) => Promise<void>,
) {
  const session = createTerminalSessionState({
    threadId: "thread",
    terminalId: "terminal",
    executionTargetId: "ssh:host=test&transport=agent",
    dropPathMode: "posix",
    cwd: "/work",
    worktreePath: null,
    history: "retained",
    cols: 80,
    rows: 24,
    runtimeEnv: null,
  });
  const resize = vi.fn();
  const reconnectRemote = vi.fn(reconnect);
  const kill = vi.fn();
  session.process = {
    pid: 42,
    remoteResourceId: "resource",
    reconnectRemote,
    resize,
    kill,
  } as unknown as PtyProcess;
  const semaphore = yield* Semaphore.make(1);
  const withThreadLock: SessionApiContext["withThreadLock"] = (_, effect) =>
    semaphore.withPermit(effect);
  const snapshot = vi.fn(() => ({ pid: 42 }) as TerminalSessionSnapshot);
  const startSession = vi.fn(() => Effect.void);
  const stopProcess = vi.fn(() => Effect.void);
  const releaseWorktreeLease = vi.fn(() => Effect.void);
  const ctx = {
    getSession: () => Effect.succeed(Option.some(session)),
    withThreadLock,
    snapshot,
    startSession,
    stopProcess,
    releaseWorktreeLease,
  } as unknown as SessionApiContext;
  return {
    open: makeTerminalOpen(ctx),
    request: {
      threadId: session.threadId,
      terminalId: session.terminalId,
      executionTargetId: session.executionTargetId,
      cwd: session.cwd,
      cols: 90,
    },
    session,
    resize,
    reconnectRemote,
    kill,
    snapshot,
    startSession,
    stopProcess,
    releaseWorktreeLease,
    withThreadLock,
  };
});

it.effect("bounds the existing observer wait and releases the thread without late mutations", () =>
  Effect.gen(function* () {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const f = yield* fixture(() => pending);
    let outcome: unknown;
    let lockAcquired = false;
    const opening = yield* f.open(f.request, "resource").pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          outcome = result;
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust(14999);
    expect(outcome).toBeUndefined();
    expect(f.reconnectRemote).toHaveBeenCalledOnce();
    const next = yield* f
      .withThreadLock(
        "thread",
        Effect.sync(() => {
          lockAcquired = true;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(lockAcquired).toBe(false);
    yield* TestClock.adjust(1);
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "TerminalExecutionTargetError",
        detail: expect.stringContaining("unconfirmed"),
      },
    });
    yield* Fiber.join(opening);
    yield* Fiber.join(next);
    expect(lockAcquired).toBe(true);
    resolve(); // Same-identity background recovery may finish after the caller left.
    yield* Effect.promise(() => pending);
    yield* Effect.yieldNow;
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.resize).not.toHaveBeenCalled();
    expect(f.startSession).not.toHaveBeenCalled();
    expect(f.stopProcess).not.toHaveBeenCalled();
    expect(f.releaseWorktreeLease).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.session.cols).toBe(80);
    expect(f.session.process?.remoteResourceId).toBe("resource");
  }),
);

it.effect("reattaches and resizes the same resource when recovery finishes promptly", () =>
  Effect.gen(function* () {
    const f = yield* fixture(async () => undefined);
    expect(yield* f.open(f.request, "resource")).toEqual({ pid: 42 });
    expect(f.resize).toHaveBeenCalledWith(90, 24);
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(f.startSession).not.toHaveBeenCalled();
    expect(f.stopProcess).not.toHaveBeenCalled();
  }),
);

it.effect("preserves identity refusal before attempting recovery", () =>
  Effect.gen(function* () {
    const f = yield* fixture(async () => undefined);
    const error = yield* f.open(f.request, "replaced-resource").pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "TerminalExecutionTargetError" });
    expect(f.reconnectRemote).not.toHaveBeenCalled();
    expect(f.snapshot).not.toHaveBeenCalled();
  }),
);

it.effect("includes same-thread queue wait in each remote Attach deadline", () =>
  Effect.gen(function* () {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const f = yield* fixture(() => pending);
    const outcomes: unknown[] = [];
    const calls = [0, 1].map((index) =>
      f.open(f.request, "resource").pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            outcomes[index] = result;
          }),
        ),
      ),
    );
    const first = yield* calls[0]!.pipe(Effect.forkChild);
    const second = yield* calls[1]!.pipe(Effect.forkChild);
    yield* TestClock.adjust(15000);
    expect(outcomes).toHaveLength(2);
    for (const result of outcomes)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "TerminalExecutionTargetError" },
      });
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    resolve();
    yield* Effect.promise(() => pending);
    yield* Effect.yieldNow;
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.resize).not.toHaveBeenCalled();
    expect(f.startSession).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.session.cols).toBe(80);
  }),
);

it.effect(
  "cancels the active observer and never starts a caller whose queue deadline expired",
  () =>
    Effect.gen(function* () {
      const signals: AbortSignal[] = [];
      const f = yield* fixture((signal) => {
        signals.push(signal!);
        return new Promise<void>((_, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
        );
      });
      let block!: () => void;
      const held = new Promise<void>((resolve) => {
        block = resolve;
      });
      const blocker = yield* f
        .withThreadLock(
          "thread",
          Effect.promise(() => held),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const opening = yield* f.open(f.request, "resource").pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(15000);
      expect(yield* Fiber.join(opening)).toMatchObject({ _tag: "Failure" });
      block();
      yield* Fiber.join(blocker);
      expect(f.reconnectRemote).not.toHaveBeenCalled();
      const active = yield* f.open(f.request, "resource").pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(15000);
      expect(yield* Fiber.join(active)).toMatchObject({ _tag: "Failure" });
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(f.snapshot).not.toHaveBeenCalled();
    }),
);

it.effect("refuses a late confirmation when the process has exited or changed", () =>
  Effect.gen(function* () {
    for (const change of ["exit", "replacement", "epoch"] as const) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      const f = yield* fixture(() => promise);
      const opening = yield* f.open(f.request, "resource").pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      if (change === "exit")
        f.session.observedExit = {
          process: f.session.process!,
          event: { exitCode: 0, signal: null },
        };
      if (change === "replacement") f.session.process = { ...f.session.process!, pid: 99 };
      if (change === "epoch") f.session.runtimeEpoch++;
      resolve();
      expect(yield* Fiber.join(opening)).toMatchObject({ _tag: "Failure" });
      expect(f.resize).not.toHaveBeenCalled();
      expect(f.snapshot).not.toHaveBeenCalled();
      expect(f.startSession).not.toHaveBeenCalled();
    }
  }),
);
