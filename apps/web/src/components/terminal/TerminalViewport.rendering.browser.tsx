import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { expect, it, vi } from "vitest";
import {
  TerminalRendererController,
  type TerminalRendererState,
} from "./TerminalRendererController";
import { TerminalRendererBudget } from "./TerminalRendererController.policy";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { TerminalViewportIntake } from "./TerminalViewport.intake";

function mountTerminal() {
  const mount = document.createElement("div");
  mount.style.cssText = "width:600px;height:300px";
  document.body.append(mount);
  const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
  terminal.open(mount);
  return {
    terminal,
    mount,
    dispose: () => {
      terminal.dispose();
      mount.remove();
    },
  };
}
const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

it.each(["auto", "on"] as const)(
  "%s real WebGL attachment/context loss preserves the same emulator and buffer",
  async (setting) => {
    const f = mountTerminal();
    let state: TerminalRendererState = { mode: "dom", reason: null };
    const budget = new TerminalRendererBudget();
    const controller = new TerminalRendererController(
      f.terminal,
      (next) => {
        state = next;
      },
      async () => () => new WebglAddon(),
      budget,
    );
    try {
      await write(f.terminal, "normal\x1b[?1049hTUI\x1b[2;3H");
      const buffer = f.terminal.buffer.active;
      controller.update(setting, true, {
        allowed: true,
        reason: null,
        webglFeatureStatus: "browser-test",
      });
      await expect.poll(() => state.mode).toBe("webgl");
      // Test-owned mount/canvas only; no private xterm/addon GPU fields.
      const canvas = Array.from(f.mount.querySelectorAll("canvas")).find((candidate) =>
        candidate.getContext("webgl2"),
      );
      expect(canvas).toBeDefined();
      const context = canvas!.getContext("webgl2")!;
      const loss = context.getExtension("WEBGL_lose_context");
      expect(loss).not.toBeNull();
      loss!.loseContext();
      // Stable addon 0.19 gives the driver three seconds to restore before public onContextLoss.
      await expect.poll(() => state.mode, { timeout: 5000 }).toBe("dom");
      expect(budget.count).toBe(0);
      expect(f.terminal.buffer.active).toBe(buffer);
      expect(buffer.getLine(0)?.translateToString(true)).toBe("      TUI");
      await write(f.terminal, "Z");
      expect(buffer.getLine(1)?.translateToString(true)).toBe("  Z");
      controller.update("off", true, {
        allowed: true,
        reason: null,
        webglFeatureStatus: "browser-test",
      });
      expect(f.terminal.buffer.active).toBe(buffer);
    } finally {
      controller.dispose();
      f.dispose();
    }
  },
);

it("pinned xterm FIFO suppresses historical replies but answers buffered live queries", async () => {
  const f = mountTerminal();
  const failure = vi.fn();
  const lane = new TerminalWriteBatcher(failure);
  const sent: string[] = [];
  const intake = new TerminalViewportIntake(
    f.terminal,
    lane,
    (event) => {
      if (event.type === "output") lane.write(f.terminal, event.data);
    },
    () => undefined,
  );
  const listener = f.terminal.onData((data) => {
    if (intake.acceptsInput) sent.push(data);
  });
  try {
    const hydrate = intake.hydrate({
      threadId: "synthetic",
      terminalId: "synthetic",
      dropPathMode: "posix",
      cwd: "/synthetic",
      worktreePath: null,
      status: "running",
      pid: 1,
      history: "\x1b[2;3H\x1b[6n",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-10-10T00:00:00.000Z",
    });
    f.terminal.input("not-replayed", true);
    intake.receive({
      type: "output",
      threadId: "synthetic",
      terminalId: "synthetic",
      data: "\x1b[6nX",
      createdAt: "2026-10-10T00:00:01.000Z",
    });
    await hydrate;
    expect(sent).toEqual(["\x1b[2;3R"]);
    expect(intake.acceptsInput).toBe(true);
    expect(f.terminal.buffer.active.getLine(1)?.translateToString(true)).toBe("  X");
    await write(f.terminal, "\x1b[6n");
    expect(sent).toEqual(["\x1b[2;3R", "\x1b[2;4R"]);
    f.terminal.input("live-user", true);
    expect(sent.at(-1)).toBe("live-user");
    lane.write(f.terminal, "Y");
    await lane.whenIdle();
    // Public empty write callback is a FIFO parser probe, not a pixel/GPU health assertion.
    await write(f.terminal, "");
    expect(f.terminal.buffer.active.getLine(1)?.translateToString(true)).toBe("  XY");
    expect(failure).not.toHaveBeenCalled();
  } finally {
    listener.dispose();
    intake.dispose();
    lane.dispose();
    f.dispose();
  }
});

it.each(["auto", "on"] as const)(
  "%s public addon activation failure preserves real xterm in DOM",
  async (setting) => {
    const f = mountTerminal();
    const original = HTMLCanvasElement.prototype.getContext;
    const context = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(function (this: HTMLCanvasElement, type, options) {
        return type === "webgl2" ? null : Reflect.apply(original, this, [type, options]);
      });
    let state: TerminalRendererState = { mode: "dom", reason: null };
    const budget = new TerminalRendererBudget();
    const controller = new TerminalRendererController(
      f.terminal,
      (next) => {
        state = next;
      },
      async () => () => new WebglAddon(),
      budget,
    );
    try {
      await write(f.terminal, "preserved");
      const buffer = f.terminal.buffer.active;
      controller.update(setting, true, {
        allowed: true,
        reason: null,
        webglFeatureStatus: "synthetic-failure",
      });
      await expect.poll(() => state.reason).toContain("attachment failed");
      expect(state.mode).toBe("dom");
      expect(budget.count).toBe(0);
      expect(f.terminal.buffer.active).toBe(buffer);
      await write(f.terminal, "-DOM");
      expect(buffer.getLine(0)?.translateToString(true)).toBe("preserved-DOM");
    } finally {
      context.mockRestore();
      controller.dispose();
      f.dispose();
    }
  },
);

it("font option changes preserve real xterm alternate-buffer, cursor and selection identity", async () => {
  const f = mountTerminal();
  try {
    await write(f.terminal, "\x1b[?1049hfont-state\x1b[3;4H");
    const buffer = f.terminal.buffer.active;
    f.terminal.select(0, 0, 4);
    f.terminal.options.fontFamily = "monospace";
    f.terminal.options.fontSize = 16;
    f.terminal.refresh(0, f.terminal.rows - 1);
    expect(f.terminal.buffer.active).toBe(buffer);
    expect([buffer.cursorX, buffer.cursorY]).toEqual([3, 2]);
    expect(f.terminal.getSelection()).toBe("font");
  } finally {
    f.dispose();
  }
});
