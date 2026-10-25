import { describe, expect, it } from "vitest";
import {
  DEV_SUPERVISOR_GRACE_MS,
  DEV_SUPERVISOR_ORPHAN_POLL_MS,
  DevSupervisor,
  parseDevCommands,
  type DevSupervisorHost,
  type ShutdownSignal,
} from "./dev-supervise.lib.ts";
import {
  DEV_ELECTRON_CHILD_GRACE_MS,
  DEV_ELECTRON_FORCE_SETTLE_MS,
  DEV_ELECTRON_GRACEFUL_STOP_MS,
  DEV_ELECTRON_MAX_SHUTDOWN_MS,
} from "./lib/dev-electron-launcher.model.ts";

/** Deterministic host: a fake process table, manual clock and recorded signals. */
function fakeHost() {
  let now = 0;
  let nextPid = 100;
  let parent = 1_000;
  const timers = new Map<number, { at: number; every: number | null; run: () => void }>();
  let nextTimer = 1;
  const alive = new Set<number>();
  const trees = new Map<number, number[]>();
  const exits = new Map<number, (code: number | null, signal: string | null) => void>();
  const signals: Array<[number, string]> = [];
  const handlers = new Map<ShutdownSignal, () => void>();
  const spawned: Array<{ name: string; prefixed: boolean; pid: number }> = [];
  let exitCode: number | null = null;
  const host: DevSupervisorHost = {
    spawn(command, prefixOutput) {
      const pid = nextPid++;
      const grandchild = nextPid++;
      alive.add(pid).add(grandchild);
      trees.set(pid, [pid, grandchild]);
      spawned.push({ name: command.name, prefixed: prefixOutput, pid });
      return { pid, onExit: (listener) => exits.set(pid, listener) };
    },
    processTree: (pid) => (trees.get(pid) ?? [pid]).filter((member) => alive.has(member)),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
    },
    alive: (pid) => alive.has(pid),
    parentPid: () => parent,
    onSignal: (signal, listener) => handlers.set(signal, listener),
    setTimer: (run, ms) => {
      timers.set(nextTimer, { at: now + ms, every: null, run });
      return nextTimer++;
    },
    setRepeating: (run, ms) => {
      timers.set(nextTimer, { at: now + ms, every: ms, run });
      return nextTimer++;
    },
    clearTimer: (id) => timers.delete(id as number),
    log: () => undefined,
    exit: (code) => {
      exitCode = code;
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every === null) timers.delete(id);
      else timer.at += timer.every;
      timer.run();
    }
    now = end;
  };
  /** A process (and optionally its whole tree) exits. */
  const exit = (pid: number, code: number | null, signal: string | null = null, tree = true) => {
    for (const member of tree ? (trees.get(pid) ?? [pid]) : [pid]) alive.delete(member);
    exits.get(pid)?.(code, signal);
  };
  return {
    host,
    advance,
    exit,
    signals,
    handlers,
    spawned,
    alive,
    get exitCode() {
      return exitCode;
    },
    orphan: () => {
      parent = 1;
    },
  };
}

const commands = parseDevCommands(["server=tsdown --watch", "electron=bun run dev-electron.mjs"]);

describe("parseDevCommands", () => {
  it("parses name=command pairs and rejects malformed ones", () => {
    expect(commands).toEqual([
      { name: "server", command: "tsdown --watch" },
      { name: "electron", command: "bun run dev-electron.mjs" },
    ]);
    expect(parseDevCommands(["web=node dev.ts --port=5173"])[0]?.command).toBe(
      "node dev.ts --port=5173",
    );
    expect(parseDevCommands(["web=node dev.ts", "--port", "it's"])).toEqual([
      { name: "web", command: "node dev.ts '--port' 'it'\\''s'" },
    ]);
    expect(() => parseDevCommands(["a=x", "b=y", "--flag"])).toThrow();
    expect(() => parseDevCommands(["--flag"])).toThrow();
    expect(() => parseDevCommands([])).toThrow();
    expect(() => parseDevCommands(["=cmd"])).toThrow();
    expect(() => parseDevCommands(["name="])).toThrow();
  });
});

describe("DevSupervisor", () => {
  it("prefixes output only when running several commands", () => {
    const single = fakeHost();
    new DevSupervisor(parseDevCommands(["web=node dev.ts"]), single.host).start();
    const several = fakeHost();
    new DevSupervisor(commands, several.host).start();
    expect(single.spawned.map((entry) => entry.prefixed)).toEqual([false]);
    expect(several.spawned.map((entry) => entry.prefixed)).toEqual([true, true]);
  });

  it("stops every process tree when its bun parent disappears (the turbo case)", () => {
    const f = fakeHost();
    new DevSupervisor(commands, f.host).start();
    f.advance(DEV_SUPERVISOR_ORPHAN_POLL_MS);
    expect(f.signals).toEqual([]);
    f.orphan();
    f.advance(DEV_SUPERVISOR_ORPHAN_POLL_MS);
    // Children and grandchildren are all signalled, not just the direct children.
    expect(f.signals).toEqual([
      [100, "SIGTERM"],
      [101, "SIGTERM"],
      [102, "SIGTERM"],
      [103, "SIGTERM"],
    ]);
    for (const { pid } of f.spawned) f.exit(pid, null, "SIGTERM");
    f.advance(50);
    expect(f.exitCode).toBe(143);
  });

  it("forwards a direct signal and waits for reparented grandchildren before exiting", () => {
    const f = fakeHost();
    new DevSupervisor(commands, f.host).start();
    f.handlers.get("SIGINT")!();
    f.handlers.get("SIGINT")!();
    expect(f.signals.filter(([, signal]) => signal === "SIGINT")).toHaveLength(4);
    // The command leaders exit, but one grandchild (the tsdown node under `bun --cwd`) lingers.
    f.exit(100, 130, null, false);
    f.exit(102, 130);
    f.advance(1_000);
    expect(f.exitCode).toBeNull();
    f.alive.delete(101);
    f.advance(50);
    expect(f.exitCode).toBe(130);
  });

  it("force-kills whatever ignores the signal after the grace period", () => {
    const f = fakeHost();
    new DevSupervisor(commands, f.host).start();
    f.handlers.get("SIGTERM")!();
    f.advance(DEV_SUPERVISOR_GRACE_MS - 1);
    expect(f.exitCode).toBeNull();
    f.advance(1);
    expect(f.signals.filter(([, signal]) => signal === "SIGKILL").map(([pid]) => pid)).toEqual([
      100, 101, 102, 103,
    ]);
    expect(f.exitCode).toBe(143);
  });

  it("stops the rest with the failing command's code, like bun run --parallel", () => {
    const f = fakeHost();
    new DevSupervisor(commands, f.host).start();
    f.exit(100, 3);
    expect(f.signals).toEqual([
      [102, "SIGTERM"],
      [103, "SIGTERM"],
    ]);
    f.exit(102, null, "SIGTERM");
    f.advance(50);
    expect(f.exitCode).toBe(3);
  });

  it("keeps the others running after a clean exit and exits 0 when all are done", () => {
    const f = fakeHost();
    new DevSupervisor(commands, f.host).start();
    f.exit(100, 0);
    f.advance(DEV_SUPERVISOR_GRACE_MS * 2);
    expect(f.signals).toEqual([]);
    expect(f.exitCode).toBeNull();
    f.exit(102, 0);
    f.advance(50);
    expect(f.exitCode).toBe(0);
  });
});

describe("dev shutdown budgets", () => {
  it("gives the Electron launcher time to finish its tree-aware stop before force-killing it", () => {
    expect(DEV_ELECTRON_MAX_SHUTDOWN_MS).toBe(
      DEV_ELECTRON_GRACEFUL_STOP_MS + DEV_ELECTRON_FORCE_SETTLE_MS + DEV_ELECTRON_CHILD_GRACE_MS,
    );
    expect(DEV_SUPERVISOR_GRACE_MS).toBe(8_000);
    // Leave at least a second of margin for ps snapshots and process exit.
    expect(DEV_SUPERVISOR_GRACE_MS - DEV_ELECTRON_MAX_SHUTDOWN_MS).toBeGreaterThanOrEqual(1_000);
  });
});
