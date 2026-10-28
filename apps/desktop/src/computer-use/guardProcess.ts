import * as ChildProcess from "node:child_process";

import { guardExitReason, type GuardExitReason } from "./guardProcess.logic";

/** The guard's orderly shutdown budget is 5 s; allow a margin before SIGKILL. */
export const GUARD_STOP_GRACE_MS = 6_000;
const STDERR_TAIL_BYTES = 4 * 1024;
/** `close` normally follows `exit` at once; bound the wait for stdio to drain. */
const STDIO_DRAIN_MS = 1_000;

export type GuardState =
  | { readonly kind: "running"; readonly pid: number }
  /** Between supervised restart attempts after an election conflict. */
  | { readonly kind: "waiting"; readonly attempt: number }
  | { readonly kind: "exited"; readonly reason: GuardExitReason; readonly stderrTail: string };

export interface GuardHandle {
  readonly state: () => GuardState;
  /** Closes the lifeline, waits for the orderly exit, then kills if needed. */
  readonly stop: () => Promise<GuardState>;
  readonly exited: Promise<GuardState>;
}

export interface StartGuardInput {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly stopGraceMs?: number;
  readonly log?: (message: string) => void;
}

/**
 * Spawns the guard with its stdin as the lifeline: the guard serves until
 * stdin reaches EOF, so Electron exiting (or `stop()`) retires it. The guard
 * ignores SIGINT/SIGTERM (a dev-terminal Ctrl-C reaches Electron's whole
 * process group), so its orderly shutdown always runs from the lifeline;
 * SIGKILL after the grace period is the only forced stop. The environment is
 * empty (the guard needs none and must not inherit credentials). stdout
 * carries control frames that are drained, not yet interpreted; stderr keeps
 * a bounded tail. Exit is reported on `close`, after stdio has drained, so
 * the tail is complete.
 */
export function startGuardProcess(input: StartGuardInput): GuardHandle {
  const log = input.log ?? (() => undefined);
  let stderrTail = "";
  let state: GuardState;
  let child: ChildProcess.ChildProcess;
  let settle!: (value: GuardState) => void;
  const exited = new Promise<GuardState>((resolve) => {
    settle = resolve;
  });
  const finish = (reason: GuardExitReason) => {
    if (state?.kind === "exited") return;
    state = { kind: "exited", reason, stderrTail };
    log(`computer-use guard exited reason=${reason}`);
    settle(state);
  };
  try {
    child = ChildProcess.spawn(input.binaryPath, [...input.args], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
    });
  } catch {
    state = { kind: "exited", reason: "spawn-failed", stderrTail };
    settle(state);
    return { state: () => state, stop: async () => state, exited };
  }
  state = { kind: "running", pid: child.pid ?? -1 };
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  // A write error on the lifeline only means the guard is gone.
  child.stdin?.on("error", () => undefined);
  child.once("error", () => finish("spawn-failed"));
  child.once("exit", (code, signal) => {
    const drained = setTimeout(() => finish(guardExitReason(code, signal)), STDIO_DRAIN_MS);
    drained.unref?.();
  });
  child.once("close", (code, signal) => finish(guardExitReason(code, signal)));
  if (child.pid === undefined) finish("spawn-failed");

  const stop = async (): Promise<GuardState> => {
    if (state.kind === "exited") return state;
    child.stdin?.end();
    const grace = input.stopGraceMs ?? GUARD_STOP_GRACE_MS;
    const timer = setTimeout(() => {
      if (state.kind === "running") child.kill("SIGKILL");
    }, grace);
    timer.unref?.();
    const result = await exited;
    clearTimeout(timer);
    return result;
  };
  return { state: () => state, stop, exited };
}
