import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodePtyProcess } from "./NodePTY";

function fixture() {
  const socket = new EventEmitter();
  const kills: string[] = [];
  const failures = new Set<string>();
  const raw = {
    pid: 4242,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    on: (event: string, listener: (...args: unknown[]) => void) => socket.on(event, listener),
    onData: (listener: (data: string) => void) => {
      socket.on("data", listener);
      return { dispose: () => socket.off("data", listener) };
    },
    onExit: (listener: (event: { exitCode: number; signal: number }) => void) => {
      socket.on("exit", listener);
      return { dispose: () => socket.off("exit", listener) };
    },
    kill: vi.fn((signal: string) => {
      kills.push(signal);
      if (failures.has(signal)) throw new Error(`cannot send ${signal}`);
    }),
  };
  const report = vi.fn();
  const process = new NodePtyProcess(raw as unknown as import("node-pty").IPty, report);
  const fatal = () =>
    socket.emit("error", Object.assign(new Error("read EBADF"), { code: "EBADF" }));
  const exit = () => socket.emit("exit", { exitCode: 0, signal: 9 });
  return { socket, raw, process, kills, failures, report, fatal, exit };
}

describe("fatal node-pty read containment", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("escalates ignored HUP and TERM once, targets only its owned PTY and never synthesizes exit", () => {
    const owned = fixture();
    const unrelated = fixture();
    const onError = vi.fn();
    const onExit = vi.fn();
    owned.process.onError(onError);
    owned.process.onExit(onExit);

    owned.fatal();
    owned.fatal();
    expect(owned.kills).toEqual(["SIGHUP"]);
    vi.advanceTimersByTime(999);
    expect(owned.kills).toEqual(["SIGHUP"]);
    vi.advanceTimersByTime(1);
    expect(owned.kills).toEqual(["SIGHUP", "SIGTERM"]);
    vi.advanceTimersByTime(1_000);
    expect(owned.kills).toEqual(["SIGHUP", "SIGTERM", "SIGKILL"]);
    vi.advanceTimersByTime(60_000);
    owned.fatal();
    expect(owned.kills).toHaveLength(3);
    expect(owned.report).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0].message).toContain("Shutdown is not yet confirmed");
    expect(onExit).not.toHaveBeenCalled();
    expect(unrelated.kills).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    owned.exit();
    unrelated.exit();
  });

  it.each(["SIGHUP", "SIGTERM", "SIGKILL"])(
    "continues bounded containment when sending %s fails without claiming exit",
    (signal) => {
      const owned = fixture();
      owned.failures.add(signal);
      const onExit = vi.fn();
      owned.process.onExit(onExit);
      expect(owned.fatal).not.toThrow();
      expect(() => vi.runAllTimers()).not.toThrow();
      expect(owned.kills).toEqual(["SIGHUP", "SIGTERM", "SIGKILL"]);
      expect(onExit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      owned.exit();
    },
  );

  it.each([0, 1_000])("cancels escalation on real exit after %dms", (elapsed) => {
    const owned = fixture();
    const onExit = vi.fn();
    owned.process.onExit(onExit);
    owned.fatal();
    vi.advanceTimersByTime(elapsed);
    owned.exit();
    const sent = [...owned.kills];
    vi.runAllTimers();
    owned.fatal();
    expect(owned.kills).toEqual(sent);
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: 0, signal: 9 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule escalation if the first signal synchronously produces a real exit", () => {
    const owned = fixture();
    owned.raw.kill.mockImplementation((signal) => {
      owned.kills.push(signal);
      owned.exit();
    });
    owned.fatal();
    expect(owned.kills).toEqual(["SIGHUP"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("latches failure for a late manager observer, blocks unusable I/O and respects unsubscribe", () => {
    const owned = fixture();
    const unsubscribed = vi.fn();
    owned.process.onError(unsubscribed)();
    const data = vi.fn();
    owned.process.onData(data);
    owned.fatal();
    const late = vi.fn();
    const unsubscribe = owned.process.onError(late);
    expect(late).toHaveBeenCalledOnce();
    expect(unsubscribed).not.toHaveBeenCalled();
    expect(() => owned.process.write("ls\r")).toThrow("PTY read failed");
    expect(() => owned.process.resize(80, 24)).toThrow("PTY read failed");
    owned.socket.emit("data", "stale\u001b[c");
    expect(data).not.toHaveBeenCalled();
    expect(owned.raw.write).not.toHaveBeenCalled();
    expect(owned.raw.resize).not.toHaveBeenCalled();
    unsubscribe();
    owned.exit();
    expect(() => owned.process.onError(vi.fn())).not.toThrow();
  });

  it("does not let logging or consumer exceptions prevent shutdown", () => {
    const owned = fixture();
    owned.report.mockImplementation(() => {
      throw new Error("logging failed");
    });
    owned.process.onError(() => {
      throw new Error("observer failed");
    });
    expect(owned.fatal).not.toThrow();
    vi.runAllTimers();
    expect(owned.kills).toEqual(["SIGHUP", "SIGTERM", "SIGKILL"]);
    owned.exit();
  });

  it("keeps EIO/EAGAIN benign with healthy I/O and no shutdown timers", () => {
    const owned = fixture();
    for (const code of ["EIO", "errno 5", "EAGAIN"]) owned.socket.emit("error", { code });
    owned.process.write("healthy");
    expect(owned.raw.write).toHaveBeenCalledWith("healthy");
    expect(owned.kills).toEqual([]);
    expect(owned.report).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    owned.exit();
  });
});
