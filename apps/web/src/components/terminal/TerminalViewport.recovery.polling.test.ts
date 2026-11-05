import { afterEach, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalRecoveryResult } from "@bigbud/contracts/workspace/terminal.recovery.ts";
import { TerminalViewportRecovery } from "./TerminalViewport.recovery";
import type { TerminalWriteBatcher } from "./TerminalWriteBatcher";

const owned: TerminalViewportRecovery[] = [];
afterEach(() => {
  owned.splice(0).forEach((view) => view.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function view(hidden = false, latency = 0) {
  vi.stubGlobal("document", { visibilityState: hidden ? "hidden" : "visible" });
  let sequence = 0;
  let output = false;
  let inFlight = 0;
  let peak = 0;
  const request = vi.fn(async (input): Promise<TerminalRecoveryResult> => {
    peak = Math.max(peak, ++inFlight);
    if (input.after && latency) await new Promise((resolve) => setTimeout(resolve, latency));
    await Promise.resolve();
    inFlight--;
    if (!input.after)
      return {
        type: "snapshot",
        frame: {
          generation: "g",
          sequence,
          cols: 80,
          rows: 24,
          ansi: "",
          pendingEscapeTail: "",
          scrollbackRows: 0,
        },
      };
    const records = output
      ? [{ type: "output" as const, generation: "g", sequence: ++sequence, data: "live" }]
      : [];
    output = false;
    return { type: "suffix", through: { generation: "g", sequence }, records };
  });
  const writes: string[] = [];
  const lane = {
    isStopped: false,
    write: (_terminal: unknown, data: string) => writes.push(data),
    whenIdle: () => Promise.resolve(),
  } as unknown as TerminalWriteBatcher;
  const fail = vi.fn();
  const recovery = new TerminalViewportRecovery(
    { resize: vi.fn() } as unknown as Terminal,
    lane,
    request,
    () => true,
    () => undefined,
    fail,
  );
  owned.push(recovery);
  await recovery.start({
    threadId: "t",
    terminalId: "default",
    runtimeGeneration: "g",
  } as TerminalSessionSnapshot);
  return {
    recovery,
    request,
    writes,
    fail,
    peak: () => peak,
    emit: () => {
      output = true;
      recovery.notify();
    },
  };
}

it("backs off six idle views and coalesces legacy wake bursts without replaying them", async () => {
  vi.useFakeTimers();
  const views = await Promise.all(Array.from({ length: 6 }, () => view()));
  await vi.advanceTimersByTimeAsync(60_000);
  for (const v of views) {
    expect(v.request.mock.calls.length).toBeLessThanOrEqual(36); // Previously 1201 per minute.
    const before = v.request.mock.calls.length;
    for (let i = 0; i < 1000; i++) v.emit();
    await vi.advanceTimersByTimeAsync(50);
    expect(v.request.mock.calls.length - before).toBe(1);
    expect(v.writes.filter((data) => data === "live")).toHaveLength(1);
    expect(v.peak()).toBe(1);
    expect(v.fail).not.toHaveBeenCalled();
  }
});

it("bounds hidden-document traffic while still consuming ordered output", async () => {
  vi.useFakeTimers();
  const views = await Promise.all(Array.from({ length: 6 }, () => view(true)));
  for (let second = 0; second < 60; second++) {
    for (const v of views) for (let event = 0; event < 100; event++) v.emit();
    await vi.advanceTimersByTimeAsync(1000);
  }
  for (const v of views) {
    expect(v.request.mock.calls.length).toBe(61);
    expect(v.writes.filter((data) => data === "live")).toHaveLength(60);
    expect(v.peak()).toBe(1);
    expect(v.fail).not.toHaveBeenCalled();
  }
});

it("does not overlap slow RPCs despite wake hints and ignores completion after disposal", async () => {
  vi.useFakeTimers();
  const v = await view(false, 1000);
  await vi.advanceTimersByTimeAsync(50);
  for (let i = 0; i < 10; i++) {
    v.emit();
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(v.request.mock.calls.length).toBe(2);
  v.recovery.dispose();
  await vi.advanceTimersByTimeAsync(5000);
  expect(v.request.mock.calls.length).toBe(2);
  expect(v.peak()).toBe(1);
  expect(v.writes).not.toContain("live");
});
