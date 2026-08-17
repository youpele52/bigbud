import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopWindowRegistry } from "./DesktopWindowRegistry";
import {
  buildMascotContextMenuTemplate,
  FloatingAssistantWindows,
} from "./floatingAssistantWindows";

interface MockWindow {
  readonly handlers: Map<string, (...args: never[]) => void>;
  readonly options: Record<string, unknown>;
  readonly webContents: { id: number };
  readonly hide: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly getBounds: ReturnType<typeof vi.fn>;
  readonly isDestroyed: ReturnType<typeof vi.fn>;
  readonly setPosition: ReturnType<typeof vi.fn>;
  readonly setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
}

const { mockWindowInstances } = vi.hoisted(() => ({
  mockWindowInstances: [] as MockWindow[],
}));

vi.mock("electron", () => ({
  BrowserWindow: class MockBrowserWindow {
    private destroyed = false;
    readonly handlers = new Map<string, (...args: never[]) => void>();
    readonly webContents = {
      id: mockWindowInstances.length + 1,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    readonly hide = vi.fn();
    readonly show = vi.fn();
    readonly showInactive = vi.fn();
    readonly focus = vi.fn();
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
      this.handlers.get("closed")?.();
    });
    readonly setVisibleOnAllWorkspaces = vi.fn();
    readonly setPosition = vi.fn();
    readonly loadURL = vi.fn();
    readonly getBounds = vi.fn(() => {
      if (this.destroyed) throw new Error("Object has been destroyed");
      return { x: 920, y: 720, width: 64, height: 64 };
    });
    readonly isDestroyed = vi.fn(() => this.destroyed);

    constructor(readonly options: Record<string, unknown>) {
      mockWindowInstances.push(this);
    }

    on(event: string, handler: (...args: never[]) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    once(event: string, handler: (...args: never[]) => void): this {
      this.handlers.set(event, handler);
      return this;
    }
  },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
    getDisplayNearestPoint: ({ x }: { x: number }) =>
      x < 0
        ? { workArea: { x: -1200, y: 0, width: 1200, height: 900 } }
        : { workArea: { x: 0, y: 0, width: 1000, height: 800 } },
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
  },
  shell: { openExternal: vi.fn() },
}));

function createWindows(mascotBounds: { x: number; y: number } | null = null) {
  const registry = new DesktopWindowRegistry();
  const updatePreferences = vi.fn();
  const windows = new FloatingAssistantWindows({
    desktopDir: "/desktop",
    desktopScheme: "bigbud",
    getSafeExternalUrl: () => null,
    isDevelopment: false,
    onOpenMain: vi.fn(),
    onQuit: vi.fn(),
    onRestart: vi.fn(),
    preferences: {
      get: () => ({
        version: 1,
        floatingAssistantEnabled: true,
        mascotVisible: true,
        mascotBounds,
      }),
      update: updatePreferences,
    } as never,
    registry,
    resolveIconPath: () => null,
    spellcheckEnabled: true,
  });
  return { registry, updatePreferences, windows };
}

describe("FloatingAssistantWindows", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockWindowInstances.length = 0;
  });

  it("hides compact chat on close while keeping the mascot active", async () => {
    const { registry, windows } = createWindows();
    await windows.openCompactChat();
    const mascot = registry.get("mascot") as unknown as MockWindow;
    const compactChat = registry.get("compact-chat") as unknown as MockWindow;
    const preventDefault = vi.fn();

    compactChat.handlers.get("close")?.({ preventDefault } as never);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(compactChat.hide).toHaveBeenCalledOnce();
    expect(compactChat.destroy).not.toHaveBeenCalled();
    expect(mascot.hide).not.toHaveBeenCalled();
    expect(registry.get("mascot")).toBe(mascot);
  });

  it("moves the mascot from the pointer's original grab position", async () => {
    const { registry, windows } = createWindows();
    await windows.ensureMascot();
    const mascot = registry.get("mascot") as unknown as MockWindow;

    expect(windows.beginMascotDrag({ x: 930, y: 730 })).toBe(true);
    expect(windows.moveMascot({ x: 100, y: 200 })).toBe(true);

    expect(mascot.setPosition).toHaveBeenCalledWith(90, 190);

    expect(windows.moveMascot({ x: -300, y: 240 })).toBe(true);
    expect(mascot.setPosition).toHaveBeenLastCalledWith(-310, 230);
  });

  it("renders the mascot on a fully transparent shadowless window", async () => {
    const { windows } = createWindows();
    await windows.ensureMascot();

    expect(mockWindowInstances[0]?.options).toMatchObject({
      backgroundColor: "#00000000",
      frame: false,
      hasShadow: false,
      height: 160,
      width: 160,
    });
  });

  it("restores the mascot on the display where it was last moved", async () => {
    const { windows } = createWindows({ x: -400, y: 220 });
    await windows.ensureMascot();

    expect(mockWindowInstances[0]?.options).toMatchObject({
      x: -400,
      y: 220,
    });
  });

  it("debounces mascot position persistence while the window is moving", async () => {
    vi.useFakeTimers();
    const { registry, updatePreferences, windows } = createWindows();
    await windows.ensureMascot();
    const mascot = registry.get("mascot") as unknown as MockWindow;

    mascot.handlers.get("moved")?.();
    mascot.handlers.get("moved")?.();

    expect(updatePreferences).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(updatePreferences).toHaveBeenCalledOnce();
    expect(updatePreferences).toHaveBeenCalledWith({ mascotBounds: { x: 920, y: 720 } });
  });

  it("shows compact chat on all workspaces", async () => {
    const { registry, windows } = createWindows();
    await windows.openCompactChat();
    const compactChat = registry.get("compact-chat") as unknown as MockWindow;

    expect(compactChat.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
    });
  });

  it("does not touch a destroyed mascot when disable races compact chat creation", async () => {
    const { registry, windows } = createWindows();

    const compactChat = windows.openCompactChat();
    windows.disable();

    await expect(compactChat).rejects.toThrow(
      "Cannot open compact chat while the floating assistant is disabled.",
    );
    expect(registry.get("compact-chat")).toBeNull();
  });

  it("places Restart bigbud immediately before Quit bigbud", () => {
    const labels = buildMascotContextMenuTemplate({
      onDisable: vi.fn(),
      onHideMascot: vi.fn(),
      onOpenChat: vi.fn(),
      onOpenMain: vi.fn(),
      onQuit: vi.fn(),
      onRestart: vi.fn(),
    }).map((item) => ("label" in item ? item.label : item.type));

    expect(labels).toEqual([
      "Open chat",
      "New chat",
      "Open bigbud",
      "separator",
      "Hide mascot",
      "Disable floating assistant",
      "separator",
      "Restart bigbud",
      "Quit bigbud",
    ]);
  });
});
