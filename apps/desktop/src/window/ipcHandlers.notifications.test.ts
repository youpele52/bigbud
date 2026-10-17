import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  instances: [] as Array<{
    handlers: Map<string, () => void>;
    options: Record<string, unknown>;
  }>,
  supported: true,
}));

vi.mock("electron", () => {
  class FakeNotification {
    static isSupported = vi.fn(() => mocks.supported);
    readonly handlers = new Map<string, () => void>();
    readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.instances.push(this);
    }

    on(event: string, handler: () => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    show(): void {}
  }

  return {
    BrowserWindow: {},
    Notification: FakeNotification,
  };
});

import { showDesktopNotification } from "./ipcHandlers.notifications";

function createWindow() {
  return {
    focus: vi.fn(),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
  };
}

describe("desktop notification click handling", () => {
  beforeEach(() => {
    mocks.instances.length = 0;
  });

  it("opens the originating thread when a targeted notification is clicked", () => {
    const window = createWindow();
    const openMainWindow = vi.fn(() => window as never);

    expect(
      showDesktopNotification(
        { title: "Task completed", body: "Finished", threadId: "thread-1" },
        () => null,
        () => null,
        openMainWindow,
      ),
    ).toBe(true);

    mocks.instances[0]?.handlers.get("click")?.();

    expect(openMainWindow).toHaveBeenCalledWith("thread-1");
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("opens the main window for generic notification clicks", () => {
    const window = createWindow();
    const openMainWindow = vi.fn(() => window as never);

    showDesktopNotification(
      { title: "Update available" },
      () => null,
      vi.fn(() => null),
      openMainWindow,
    );
    mocks.instances[0]?.handlers.get("click")?.();

    expect(openMainWindow).toHaveBeenCalledWith(undefined);
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("treats a blank thread target as an app-only notification", () => {
    const window = createWindow();
    const openMainWindow = vi.fn(() => window as never);

    showDesktopNotification(
      { title: "Task completed", threadId: "  " },
      () => null,
      vi.fn(() => null),
      openMainWindow,
    );
    mocks.instances[0]?.handlers.get("click")?.();

    expect(openMainWindow).toHaveBeenCalledWith(undefined);
  });
});
