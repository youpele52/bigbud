import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { attachBackendChildLifecycle } from "./backendManager.child";
import {
  beginBackendStartup,
  configureBackendStartupState,
  getBackendStartupState,
  recordBackendStartupStatus,
} from "./backendStartupState";
import { isBackendStartupState } from "./backendStartupDiagnostics.validation";
import { listenForBackendStartupStatus } from "./backendStartupStatusPipe";

beforeEach(() => {
  vi.useFakeTimers();
  configureBackendStartupState("startup-test", true);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function setup(options: { expected?: boolean; quitting?: boolean; development?: boolean } = {}) {
  const child = new EventEmitter() as ChildProcess;
  const stream = new PassThrough();
  const generation = beginBackendStartup();
  const scheduleRestart = vi.fn();
  const onDisconnected = vi.fn();
  const logLifecycle = vi.fn();
  let stderrTail = "";
  attachBackendChildLifecycle(child, {
    generation,
    isDevelopmentDiagnostics: options.development ?? true,
    getIsQuitting: () => options.quitting ?? false,
    isExpectedExit: () => options.expected ?? false,
    getStderrTail: () => stderrTail,
    onDisconnected,
    closeSession: vi.fn(),
    logLifecycle,
    scheduleRestart,
  });
  listenForBackendStartupStatus(stream, generation);
  return {
    child,
    stream,
    generation,
    scheduleRestart,
    onDisconnected,
    logLifecycle,
    setStderr: (value: string) => {
      stderrTail = value;
    },
  };
}

it.each(["state_directory_in_use", "state_directory_owner_unverified"])(
  "preserves %s after exit and late pipe delivery, without scheduling another startup",
  (reason) => {
    const run = setup();
    run.child.emit("exit", 1, null);
    expect(getBackendStartupState().status).toBe("starting");
    expect(run.scheduleRestart).not.toHaveBeenCalled();
    run.stream.write(`${JSON.stringify({ status: "error", reason })}\n`);
    run.stream.write('{"status":"error","reason":"bootstrap_failed"}\n');
    run.setStderr(
      "Ownership cannot be verified: /Users/example/.bigbud/dev/backend.lock token=private",
    );
    run.child.emit("close", 1, null);
    vi.advanceTimersByTime(20 * 60_000);
    const state = getBackendStartupState();
    expect(state).toMatchObject({
      generation: run.generation,
      status: "failed",
      failureReason: reason,
    });
    expect(state.developmentDiagnostics?.stderrTail).toContain("/Users/example/.bigbud");
    expect(state.developmentDiagnostics?.stderrTail).not.toContain("token=private");
    expect(isBackendStartupState(state, true)).toBe(true);
    expect(run.scheduleRestart).not.toHaveBeenCalled();
    expect(run.onDisconnected).toHaveBeenCalledOnce();
    expect(run.logLifecycle).toHaveBeenCalledWith(
      "restart_blocked",
      expect.stringContaining(reason),
    );
  },
);

it.each(["bootstrap_failed", "server_runtime_startup_failed", "unknown", "untrusted"])(
  "continues normal restart policy for %s",
  (reason) => {
    const run = setup();
    run.stream.write(`${JSON.stringify({ status: "error", reason })}\n`);
    run.child.emit("close", 1, null);
    expect(run.scheduleRestart).toHaveBeenCalledExactlyOnceWith("code=1 signal=null");
  },
);

it("restarts a child that exits without a status and retains its failure details", () => {
  const run = setup();
  run.setStderr("unexpected runtime failure");
  run.child.emit("close", 1, null);
  expect(run.scheduleRestart).toHaveBeenCalledExactlyOnceWith(
    "code=1 signal=null stderr=unexpected runtime failure",
  );
  expect(getBackendStartupState()).toMatchObject({
    status: "failed",
    failureReason: "child_exit_before_ready",
  });
});

it("restarts a ready backend that later crashes", () => {
  const run = setup();
  recordBackendStartupStatus(run.generation, "ready");
  run.child.emit("close", 1, null);
  expect(run.scheduleRestart).toHaveBeenCalledOnce();
  expect(getBackendStartupState().status).toBe("ready");
});

it.each([{ expected: true }, { quitting: true }])(
  "does not restart during expected shutdown %j",
  (options) => {
    const run = setup(options);
    run.child.emit("close", 0, null);
    expect(run.scheduleRestart).not.toHaveBeenCalled();
  },
);

it("retains ordinary asynchronous spawn-error recovery", () => {
  const run = setup();
  run.child.emit("error", new Error("spawn failed"));
  expect(run.scheduleRestart).toHaveBeenCalledExactlyOnceWith("spawn failed");
  expect(getBackendStartupState()).toMatchObject({
    status: "failed",
    failureReason: "child_spawn_failed",
  });
});

it("does not expose development stderr in packaged startup state", () => {
  const run = setup({ development: false });
  configureBackendStartupState("startup-test", false);
  run.stream.write('{"status":"error","reason":"state_directory_in_use"}\n');
  run.setStderr("private local path: /Users/example/.bigbud/dev/backend.lock");
  run.child.emit("close", 1, null);
  expect(getBackendStartupState().developmentDiagnostics).toBeUndefined();
  expect(isBackendStartupState(getBackendStartupState())).toBe(true);
});

it("allows a deliberate new generation after external recovery", () => {
  const run = setup();
  run.stream.write('{"status":"error","reason":"state_directory_owner_unverified"}\n');
  run.child.emit("close", 1, null);
  const next = beginBackendStartup();
  recordBackendStartupStatus(next, "ready");
  expect(getBackendStartupState()).toMatchObject({ generation: next, status: "ready" });
  expect(getBackendStartupState().failureReason).toBeUndefined();
});
