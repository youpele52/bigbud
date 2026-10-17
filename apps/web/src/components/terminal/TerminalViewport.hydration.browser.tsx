import "../../index.css";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { expect, it, vi } from "vitest";
import { TerminalViewportIntake } from "./TerminalViewport.intake";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";

it("restores parser carry at a snapshot cut before applying the live control tail", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  const failure = vi.fn();
  const lane = new TerminalWriteBatcher(failure);
  const intake = new TerminalViewportIntake(
    terminal,
    lane,
    (event) => {
      if (event.type === "output") lane.write(terminal, event.data);
    },
    () => undefined,
  );
  try {
    const hydration = intake.hydrate({
      threadId: "split",
      terminalId: "default",
      cwd: "/",
      worktreePath: null,
      dropPathMode: "posix",
      status: "running",
      pid: 1,
      history: "\x1b[3",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-10-17T00:00:00.000Z",
    });
    intake.receive({
      type: "output",
      threadId: "split",
      terminalId: "default",
      data: "2mPi",
      createdAt: "2026-10-17T00:00:00.001Z",
    });
    await hydration;
    await lane.whenIdle();
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("Pi");
    expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(2);
    expect(intake.acceptsInput).toBe(true);
    expect(failure).not.toHaveBeenCalled();
  } finally {
    intake.dispose();
    lane.dispose();
    terminal.dispose();
  }
});

it.each([false, true])(
  "large history and continuous redraws hand off with real xterm (GPU=%s)",
  async (gpu) => {
    const mount = document.createElement("div");
    mount.style.cssText = "width:1000px;height:600px";
    document.body.append(mount);
    const terminal = new Terminal({ cols: 120, rows: 40 });
    terminal.open(mount);
    if (gpu) terminal.loadAddon(new WebglAddon());
    const failure = vi.fn();
    const lane = new TerminalWriteBatcher(failure);
    const intake = new TerminalViewportIntake(
      terminal,
      lane,
      (event) => {
        if (event.type === "output") lane.write(terminal, event.data);
      },
      () => undefined,
    );
    const seen: string[] = [];
    const replies: string[] = [];
    const marker = terminal.parser.registerOscHandler(777, (value) => {
      seen.push(value);
      return true;
    });
    const data = terminal.onData((value) => replies.push(value));
    const redraw =
      "\x1b[H" +
      Array.from(
        { length: 40 },
        (_, row) => `\x1b[${row + 1};1H\x1b[32m${"x".repeat(115)}\x1b[0m`,
      ).join("");
    const snapshot = {
      threadId: "synthetic",
      terminalId: "synthetic",
      cwd: "/synthetic",
      worktreePath: null,
      dropPathMode: "posix" as const,
      status: "running" as const,
      pid: 1,
      history: "\x1b[?1049h" + redraw.repeat(800) + "\x1b[6n",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-10-11T00:00:00.000Z",
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      // The real manager publishes this snapshot before the open response.
      intake.receive({
        type: "started",
        threadId: "synthetic",
        terminalId: "synthetic",
        createdAt: snapshot.updatedAt,
        snapshot,
      });
      const hydration = intake.hydrate(snapshot);
      let count = 0;
      const stream = new Promise<void>((resolve) => {
        timer = setInterval(() => {
          intake.receive({
            type: "output",
            threadId: "synthetic",
            terminalId: "synthetic",
            createdAt: "2026-10-11T00:00:01.000Z",
            data: redraw + `\x1b]777;N${count}\x07` + (count === 0 ? "\x1b[6n" : ""),
          });
          // Real geometry changes during replay/redraw, without replacing the emulator.
          if (count === 5) terminal.resize(140, 45);
          if (count === 15) terminal.resize(100, 35);
          if (++count === 100) {
            clearInterval(timer);
            resolve();
          }
        }, 16);
      });
      await hydration;
      expect(count).toBeLessThan(100);
      expect(intake.acceptsInput).toBe(true);
      await stream;
      await lane.whenIdle();
      expect(failure).not.toHaveBeenCalled();
      expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => `N${i}`));
      expect(replies).toHaveLength(1); // Only the LIVE query, never the historical one.
      expect(terminal.buffer.active.type).toBe("alternate");
      expect(lane.queuedBytes).toBe(0);
    } finally {
      clearInterval(timer);
      marker.dispose();
      data.dispose();
      intake.dispose();
      lane.dispose();
      terminal.dispose();
      mount.remove();
    }
  },
);
