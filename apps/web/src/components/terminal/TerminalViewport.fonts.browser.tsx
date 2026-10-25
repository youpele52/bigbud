import "../../index.css";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type TerminalFontFamily,
} from "@bigbud/contracts/core/settings.ts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TerminalSessionFixture } from "./TerminalViewport.session.fixture";
import { TerminalFontController } from "./TerminalFontController";
import { getLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_OPTIONS,
} from "../../hooks/useSettings.storage";
import {
  bundledTerminalFontFromSettings,
  SYSTEM_TERMINAL_FONT_FAMILY,
  terminalFontFamilyFromSettings,
  terminalLineHeightFromSettings,
} from "./terminalTypography";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async (input: { cols: number; rows: number }) => ({
    ...input,
    threadId: "terminal-fixture",
    terminalId: "synthetic",
    dropPathMode: "posix",
    cwd: "/synthetic",
    worktreePath: null,
    status: "running",
    pid: 1,
    history: "\x1b[?1049hfont-state\x1b[3;4H",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-14T00:00:00.000Z",
  })),
  resize: vi.fn(async (_input: { cols: number; rows: number }) => undefined),
  write: vi.fn(async () => undefined),
}));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));

function typography(font: TerminalFontFamily) {
  return {
    terminalFontFamily: terminalFontFamilyFromSettings(font),
    terminalFontSize: 12,
    terminalLineHeight: terminalLineHeightFromSettings(font),
    bundledTerminalFont: bundledTerminalFontFromSettings(font),
  };
}

function cellSize(mount: HTMLElement, terminal: Terminal) {
  const screen = mount.querySelector<HTMLElement>(".xterm-screen")!;
  const bounds = screen.getBoundingClientRect();
  return { width: bounds.width / terminal.cols, height: bounds.height / terminal.rows };
}

it("persists the migrated default in real browser storage and renders JetBrains Mono", async () => {
  localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
  localStorage.setItem(
    "bigbud:client-settings:v1",
    JSON.stringify({
      ...DEFAULT_CLIENT_SETTINGS,
      terminalFontFamily: "meslo-nerd-font-mono",
      terminalFontSize: 14,
    }),
  );
  const settings = getLocalStorageItem(
    CLIENT_SETTINGS_STORAGE_KEY,
    ClientSettingsSchema,
    CLIENT_SETTINGS_STORAGE_OPTIONS,
  )!;
  expect(JSON.parse(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY)!)).toMatchObject({
    terminalFontFamily: "jetbrains-mono-nerd-font",
    terminalFontSize: 14,
  });
  let terminal: Terminal | null = null;
  const onTerminal = (value: Terminal | null) => {
    terminal = value;
  };
  const screen = await render(
    <TerminalSessionFixture
      fontSize={settings.terminalFontSize}
      fontFamily={settings.terminalFontFamily}
      onTerminal={onTerminal}
    />,
  );
  try {
    await expect.poll(() => terminal?.options.disableStdin).toBe(false);
    expect(terminal!.options.fontFamily).toContain("JetBrainsMono Nerd Font Mono");
    expect(terminal!.options.fontSize).toBe(14);
    expect(localStorage.getItem("bigbud:client-settings:v1")).toBeNull();
  } finally {
    await screen.unmount();
    localStorage.removeItem(CLIENT_SETTINGS_STORAGE_KEY);
    localStorage.removeItem("bigbud:client-settings:v1");
  }
});

it.each(["dom", "webgl"] as const)(
  "%s: the actual JetBrains Mono asset has a less narrow/tall grid than legacy Meslo",
  async (renderer) => {
    const mount = document.createElement("div");
    mount.style.cssText = "width:600px;height:300px";
    document.body.append(mount);
    const terminal = new Terminal({ fontFamily: SYSTEM_TERMINAL_FONT_FAMILY, fontSize: 12 });
    const controller = new TerminalFontController(terminal);
    try {
      terminal.open(mount);
      if (renderer === "webgl") terminal.loadAddon(new WebglAddon());
      await controller.update(typography("meslo-nerd-font-mono"));
      await expect.poll(() => terminal.options.fontFamily).toContain("MesloLGL");
      const meslo = cellSize(mount, terminal);
      await controller.update(typography("jetbrains-mono-nerd-font"));
      await expect.poll(() => terminal.options.fontFamily).toContain("JetBrainsMono");
      const jetbrains = cellSize(mount, terminal);
      expect(jetbrains.width).toBeGreaterThan(0);
      expect(jetbrains.height).toBeLessThan(meslo.height * 0.8);
      expect(jetbrains.width / jetbrains.height).toBeGreaterThan(
        (meslo.width / meslo.height) * 1.2,
      );
      expect(jetbrains.width / meslo.width).toBeGreaterThan(0.9);
      expect(jetbrains.width / meslo.width).toBeLessThan(1.1);
    } finally {
      controller.dispose();
      terminal.dispose();
      mount.remove();
    }
  },
);

it("font switches refit the existing PTY and preserve its emulator, buffer and cursor", async () => {
  vi.clearAllMocks();
  let terminal: Terminal | null = null;
  const onTerminal = (value: Terminal | null) => {
    terminal = value;
  };
  const screen = await render(
    <TerminalSessionFixture
      fontSize={12}
      fontFamily="jetbrains-mono-nerd-font"
      onTerminal={onTerminal}
    />,
  );
  try {
    await expect.poll(() => terminal?.options.disableStdin).toBe(false);
    const original = terminal!;
    const buffer = original.buffer.active;
    original.select(0, 0, 4);
    const compactRows = original.rows;
    await screen.rerender(
      <TerminalSessionFixture
        fontSize={12}
        fontFamily="meslo-nerd-font-mono"
        onTerminal={onTerminal}
      />,
    );
    await expect.poll(() => original.rows).toBeLessThan(compactRows);
    await expect
      .poll(() => mocks.resize.mock.calls.at(-1)?.[0])
      .toMatchObject({ cols: original.cols, rows: original.rows });
    expect(terminal).toBe(original);
    expect(original.buffer.active).toBe(buffer);
    expect([buffer.cursorX, buffer.cursorY]).toEqual([3, 2]);
    // xterm clears selection on grid resize, unlike a font-only option update.
    expect(original.getSelection()).toBe("");
    expect(mocks.open).toHaveBeenCalledOnce();
    await screen.rerender(
      <TerminalSessionFixture
        fontSize={12}
        fontFamily="jetbrains-mono-nerd-font"
        onTerminal={onTerminal}
      />,
    );
    await expect.poll(() => original.rows).toBe(compactRows);
    expect(mocks.open).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});

it("waits for JetBrains Mono before opening the PTY when its font finishes within the startup budget", async () => {
  vi.clearAllMocks();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalLoad = document.fonts.load.bind(document.fonts);
  const load = vi.spyOn(document.fonts, "load").mockImplementation(async (font, text) => {
    await gate;
    return originalLoad(font, text);
  });
  const terminalRef = { current: null as Terminal | null };
  const screen = await render(
    <TerminalSessionFixture
      fontSize={12}
      fontFamily="jetbrains-mono-nerd-font"
      onTerminal={(value) => {
        terminalRef.current = value;
      }}
    />,
  );
  try {
    expect(load).toHaveBeenCalledOnce();
    expect(terminalRef.current?.options.fontFamily).toBe(SYSTEM_TERMINAL_FONT_FAMILY);
    expect(mocks.open).not.toHaveBeenCalled();
    release();
    await expect.poll(() => terminalRef.current?.options.disableStdin).toBe(false);
    expect(terminalRef.current?.options.fontFamily).toContain("JetBrainsMono Nerd Font Mono");
    expect(mocks.open.mock.calls[0]?.[0]).toMatchObject({
      cols: terminalRef.current!.cols,
      rows: terminalRef.current!.rows,
    });
  } finally {
    release();
    await screen.unmount();
    load.mockRestore();
  }
});

it("failed font assets fall back without blocking the PTY", async () => {
  vi.clearAllMocks();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const load = vi
    .spyOn(document.fonts, "load")
    .mockRejectedValue(new Error("synthetic font failure"));
  const terminalRef = { current: null as Terminal | null };
  const screen = await render(
    <TerminalSessionFixture
      fontSize={12}
      fontFamily="jetbrains-mono-nerd-font"
      onTerminal={(value) => {
        terminalRef.current = value;
      }}
    />,
  );
  try {
    await expect.poll(() => terminalRef.current?.options.disableStdin).toBe(false);
    expect(terminalRef.current?.options.fontFamily).toBe(SYSTEM_TERMINAL_FONT_FAMILY);
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
    load.mockRestore();
    warning.mockRestore();
  }
});

it("slow fonts start on fallback then remeasure and resize when the chosen font finishes", async () => {
  vi.clearAllMocks();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalLoad = document.fonts.load.bind(document.fonts);
  const load = vi.spyOn(document.fonts, "load").mockImplementation(async (font, text) => {
    await gate;
    return originalLoad(font, text);
  });
  let terminal: Terminal | null = null;
  const onTerminal = (value: Terminal | null) => {
    terminal = value;
  };
  const screen = await render(
    <TerminalSessionFixture
      fontSize={12}
      fontFamily="meslo-nerd-font-mono"
      onTerminal={onTerminal}
    />,
  );
  try {
    await expect.poll(() => terminal?.options.disableStdin).toBe(false);
    const original = terminal!;
    expect(original.options.fontFamily).toBe(SYSTEM_TERMINAL_FONT_FAMILY);
    const fallbackRows = original.rows;
    release();
    await expect.poll(() => original.options.fontFamily).toContain("MesloLGL");
    await expect.poll(() => original.rows).toBeLessThan(fallbackRows);
    await expect
      .poll(() => mocks.resize.mock.calls.at(-1)?.[0])
      .toMatchObject({ cols: original.cols, rows: original.rows });
    expect(terminal).toBe(original);
    expect(mocks.open).toHaveBeenCalledOnce();
  } finally {
    release();
    await screen.unmount();
    load.mockRestore();
  }
});
