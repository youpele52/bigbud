import { describe, expect, it, vi } from "vitest";

import { createCompactLinkHandoffCoordinator } from "./main.compactLinkHandoff";

function createWindow() {
  const handlers = new Map<string, () => void>();
  const webContents = {
    on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    isLoadingMainFrame: vi.fn(() => false),
    send: vi.fn(),
  };
  const window = {
    webContents,
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    once: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
  };
  return { handlers, window };
}

const firstHandoff = {
  type: "compact-chat-link" as const,
  threadId: "thread-1",
  href: "first.md",
  workspaceRoot: "/workspace",
};

describe("compact link handoff coordinator", () => {
  it("delivers only the latest request after the main renderer is ready", () => {
    const { window } = createWindow();
    const coordinator = createCompactLinkHandoffCoordinator({
      getMainWindow: () => window as never,
      openMainWindow: () => window as never,
      menuActionChannel: "desktop:menu-action",
    });

    coordinator.attachMainWindow(window as never);
    coordinator.request(firstHandoff);
    coordinator.request({ ...firstHandoff, href: "latest.md" });
    expect(window.webContents.send).not.toHaveBeenCalled();

    coordinator.markRendererReady(window as never);

    expect(window.webContents.send).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith("desktop:menu-action", {
      ...firstHandoff,
      href: "latest.md",
    });
  });

  it("retains pending requests through reload and clears them on close", () => {
    const { handlers, window } = createWindow();
    const coordinator = createCompactLinkHandoffCoordinator({
      getMainWindow: () => window as never,
      openMainWindow: () => window as never,
      menuActionChannel: "desktop:menu-action",
    });

    coordinator.attachMainWindow(window as never);
    coordinator.markRendererReady(window as never);
    window.webContents.isLoadingMainFrame.mockReturnValue(true);
    handlers.get("did-start-loading")?.();
    coordinator.request(firstHandoff);
    handlers.get("did-start-loading")?.();
    window.webContents.isLoadingMainFrame.mockReturnValue(false);
    coordinator.markRendererReady(window as never);
    expect(window.webContents.send).toHaveBeenCalledOnce();

    handlers.get("closed")?.();
    coordinator.request({ ...firstHandoff, href: "cleared.md" });
    handlers.get("closed")?.();
    coordinator.markRendererReady(window as never);
    expect(window.webContents.send).not.toHaveBeenCalledWith("desktop:menu-action", {
      ...firstHandoff,
      href: "cleared.md",
    });
  });

  it("still delivers later handoffs after a guest-frame load", () => {
    const { handlers, window } = createWindow();
    const coordinator = createCompactLinkHandoffCoordinator({
      getMainWindow: () => window as never,
      openMainWindow: () => window as never,
      menuActionChannel: "desktop:menu-action",
    });

    coordinator.attachMainWindow(window as never);
    coordinator.markRendererReady(window as never);
    coordinator.request(firstHandoff);
    window.webContents.send.mockClear();

    handlers.get("did-start-loading")?.();
    coordinator.request({ ...firstHandoff, href: "https://localhost:4321/docs" });

    expect(window.webContents.send).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith("desktop:menu-action", {
      ...firstHandoff,
      href: "https://localhost:4321/docs",
    });
  });

  it("does not show or focus a loading main window during a request", () => {
    const { window } = createWindow();
    window.webContents.isLoadingMainFrame.mockReturnValue(true);
    const coordinator = createCompactLinkHandoffCoordinator({
      getMainWindow: () => window as never,
      openMainWindow: () => window as never,
      menuActionChannel: "desktop:menu-action",
    });

    coordinator.request(firstHandoff);

    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();

    window.webContents.isLoadingMainFrame.mockReturnValue(false);
    window.isVisible.mockReturnValue(false);
    coordinator.markRendererReady(window as never);

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith("desktop:menu-action", firstHandoff);
  });
});
