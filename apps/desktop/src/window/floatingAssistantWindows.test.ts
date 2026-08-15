import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopWindowRegistry } from "./DesktopWindowRegistry";
import { FloatingAssistantWindows } from "./floatingAssistantWindows";

interface MockWindow {
  readonly handlers: Map<string, (...args: never[]) => void>;
  readonly webContents: { id: number };
  readonly hide: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly setPosition: ReturnType<typeof vi.fn>;
  readonly setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
}

const { mockWindowInstances } = vi.hoisted(() => ({
  mockWindowInstances: [] as MockWindow[],
}));

vi.mock("electron", () => ({
  BrowserWindow: class MockBrowserWindow {
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
    readonly destroy = vi.fn();
    readonly setVisibleOnAllWorkspaces = vi.fn();
    readonly setPosition = vi.fn();
    readonly loadURL = vi.fn();
    readonly getBounds = vi.fn(() => ({ x: 920, y: 720, width: 64, height: 64 }));
    readonly isDestroyed = vi.fn(() => false);

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
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
  },
  shell: { openExternal: vi.fn() },
}));

function createWindows() {
  const registry = new DesktopWindowRegistry();
  const windows = new FloatingAssistantWindows({
    desktopDir: "/desktop",
    desktopScheme: "bigbud",
    getSafeExternalUrl: () => null,
    isDevelopment: false,
    onOpenMain: vi.fn(),
    onQuit: vi.fn(),
    preferences: {
      get: () => ({
        version: 1,
        floatingAssistantEnabled: true,
        mascotVisible: true,
        mascotBounds: null,
      }),
      update: vi.fn(),
    } as never,
    registry,
    resolveIconPath: () => null,
    spellcheckEnabled: true,
  });
  return { registry, windows };
}

describe("FloatingAssistantWindows", () => {
  beforeEach(() => {
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
  });

  it("shows compact chat on all workspaces", async () => {
    const { registry, windows } = createWindows();
    await windows.openCompactChat();
    const compactChat = registry.get("compact-chat") as unknown as MockWindow;

    expect(compactChat.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
    });
  });
});
