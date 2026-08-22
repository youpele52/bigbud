import { describe, expect, it, vi } from "vitest";

import { createWindow } from "./windowManager";

const {
  attachGuestMock,
  bindBrowserNavigationPolicyMock,
  buildFromTemplateMock,
  closeHostMock,
  initializeBrowserSessionMock,
  isBrowserGuestMock,
  initializationOrder,
  mockWindowInstances,
  popupMock,
} = vi.hoisted(() => ({
  popupMock: vi.fn(),
  buildFromTemplateMock: vi.fn(() => ({ popup: vi.fn() })),
  attachGuestMock: vi.fn(),
  bindBrowserNavigationPolicyMock: vi.fn(),
  closeHostMock: vi.fn(),
  initializeBrowserSessionMock: vi.fn(),
  isBrowserGuestMock: vi.fn(),
  initializationOrder: [] as string[],
  mockWindowInstances: [] as Array<any>,
}));

vi.mock("./certificateChallengeManager", () => ({
  certificateChallengeManager: {
    attachGuest: attachGuestMock,
    closeHost: closeHostMock,
  },
}));

vi.mock("./browserNavigationPolicy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browserNavigationPolicy")>();
  return {
    ...actual,
    bindBrowserNavigationPolicy: bindBrowserNavigationPolicyMock,
  };
});

vi.mock("./browserSession", () => ({
  BROWSER_SESSION_PARTITION: "persist:bigbud-browser",
  initializeBrowserSession: initializeBrowserSessionMock,
  isBrowserGuest: isBrowserGuestMock,
}));

type MenuTemplateEntry = {
  label?: string;
  role?: string;
  enabled?: boolean;
  click?: () => void;
};

vi.mock("electron", () => {
  class MockBrowserWindow {
    constructor(public options?: Record<string, unknown>) {
      initializationOrder.push("window");
      mockWindowInstances.push(this);
    }

    webContents = {
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      },
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === "context-menu") {
          this.contextMenuHandler = handler;
        }
        if (event === "did-attach-webview") {
          this.didAttachWebviewHandler = handler;
        }
        if (event === "will-attach-webview") {
          this.willAttachWebviewHandler = handler;
        }
      }),
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      loadURL: vi.fn(),
      replaceMisspelling: vi.fn(),
      copyImageAt: vi.fn(),
      send: vi.fn(),
    };
    windowHandlers = new Map<string, (...args: any[]) => void>();
    on = vi.fn((event: string, handler: (...args: any[]) => void) => {
      this.windowHandlers.set(event, handler);
    });
    once = vi.fn();
    show = vi.fn();
    setTitle = vi.fn();
    setBackgroundColor = vi.fn();
    setVibrancy = vi.fn();
    loadURL = vi.fn();
    contextMenuHandler: ((event: { preventDefault: () => void }, params: any) => void) | null =
      null;
    didAttachWebviewHandler: ((event: unknown, guestWebContents: any) => void) | null = null;
    willAttachWebviewHandler:
      | ((
          event: { preventDefault(): void },
          webPreferences: any,
          params: { partition?: string; src?: string },
        ) => void)
      | null = null;
  }

  return {
    BrowserWindow: MockBrowserWindow,
    Menu: {
      buildFromTemplate: buildFromTemplateMock,
    },
    nativeTheme: {
      shouldUseDarkColors: false,
      on: vi.fn(),
      off: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(),
    },
  };
});

function createWindowUnderTest() {
  createWindow({
    appDisplayName: "bigbud",
    desktopScheme: "bigbud",
    isDevelopment: false,
    desktopDir: "/desktop",
    menuActionChannel: "desktop:menu-action",
    spellcheckEnabled: true,
    resolveIconPath: () => null,
    getSafeExternalUrl: () => null,
    emitUpdateState: () => undefined,
    onWindowClosed: () => undefined,
  });

  return mockWindowInstances.at(-1) ?? null;
}

describe("windowManager context menu", () => {
  it("initializes the browser session before creating windows reopened by activation or single-instance", () => {
    mockWindowInstances.length = 0;
    initializationOrder.length = 0;
    initializeBrowserSessionMock.mockImplementation(() => {
      initializationOrder.push("browser session");
    });

    createWindowUnderTest();

    expect(initializationOrder).toEqual(["browser session", "window"]);
  });

  it("passes spellcheck through to webPreferences", () => {
    mockWindowInstances.length = 0;

    createWindow({
      appDisplayName: "bigbud",
      desktopScheme: "bigbud",
      isDevelopment: false,
      desktopDir: "/desktop",
      menuActionChannel: "desktop:menu-action",
      spellcheckEnabled: false,
      resolveIconPath: () => null,
      getSafeExternalUrl: () => null,
      emitUpdateState: () => undefined,
      onWindowClosed: () => undefined,
    });

    const window = mockWindowInstances.at(-1);
    expect(window?.options).toMatchObject({
      webPreferences: expect.objectContaining({
        plugins: true,
        spellcheck: false,
        webviewTag: true,
      }),
    });

    if (process.platform === "darwin") {
      expect(window?.options).toMatchObject({
        transparent: true,
        visualEffectState: "active",
      });
    }
  });

  it("closes the browser context menu on guest left clicks", () => {
    mockWindowInstances.length = 0;
    attachGuestMock.mockClear();
    bindBrowserNavigationPolicyMock.mockClear();
    isBrowserGuestMock.mockReturnValue(true);
    const window = createWindowUnderTest();
    const guestHandlers = new Map<string, (...args: any[]) => void>();
    const guestWebContents = {
      id: 2,
      once: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        guestHandlers.set(event, handler);
      }),
      setWindowOpenHandler: vi.fn(),
    };

    window?.didAttachWebviewHandler?.({}, guestWebContents);
    const beforeMouseEvent = guestHandlers.get("before-mouse-event");
    beforeMouseEvent?.({}, { type: "mouseDown", button: "left" });
    beforeMouseEvent?.({}, { type: "mouseUp", button: "left" });
    beforeMouseEvent?.({}, { type: "mouseDown", button: "right" });

    expect(window?.webContents.send).toHaveBeenCalledTimes(1);
    expect(attachGuestMock).toHaveBeenCalledWith(window?.webContents, guestWebContents);
    expect(bindBrowserNavigationPolicyMock).toHaveBeenCalledWith(guestWebContents);
    const guestWindowOpenHandler = guestWebContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(guestWindowOpenHandler?.({ url: "https://untrusted.example/popup" })).toEqual({
      action: "deny",
    });
    expect(window?.webContents.send).toHaveBeenCalledWith(
      "desktop:menu-action",
      "close-browser-context-menu",
    );
  });

  it("binds navigation policy only to visible browser guests", () => {
    mockWindowInstances.length = 0;
    bindBrowserNavigationPolicyMock.mockClear();
    isBrowserGuestMock.mockReturnValue(false);
    const window = createWindowUnderTest();
    const guestWebContents = { id: 2, on: vi.fn(), once: vi.fn() };

    window?.didAttachWebviewHandler?.({}, guestWebContents);

    expect(bindBrowserNavigationPolicyMock).not.toHaveBeenCalled();
  });

  it("hardens browser guest privileges without changing PDF or media preferences", () => {
    mockWindowInstances.length = 0;
    const window = createWindowUnderTest();
    const webPreferences = {
      autoplayPolicy: "no-user-gesture-required",
      allowRunningInsecureContent: true,
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      plugins: true,
      preload: "/untrusted/preload.js",
      sandbox: false,
      webSecurity: false,
      webviewTag: true,
    };

    window?.willAttachWebviewHandler?.({ preventDefault: vi.fn() }, webPreferences, {
      partition: "persist:bigbud-browser",
      src: "https://example.com",
    });

    expect(webPreferences).toMatchObject({
      autoplayPolicy: "no-user-gesture-required",
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      plugins: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });
    expect(webPreferences).not.toHaveProperty("preload");
  });

  it("leaves non-browser webview preferences unchanged", () => {
    mockWindowInstances.length = 0;
    const window = createWindowUnderTest();
    const webPreferences = {
      autoplayPolicy: "no-user-gesture-required",
      allowRunningInsecureContent: true,
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      plugins: true,
      preload: "/trusted/preload.js",
      sandbox: false,
      webSecurity: false,
      webviewTag: true,
    };
    const originalPreferences = { ...webPreferences };

    window?.willAttachWebviewHandler?.({ preventDefault: vi.fn() }, webPreferences, {
      partition: "persist:other",
      src: "file:///trusted/local.html",
    });

    expect(webPreferences).toEqual(originalPreferences);
  });

  it.each([
    ["file:///etc/passwd", true],
    [undefined, false],
  ])("enforces initial browser guest navigation for %s", (src, blocked) => {
    mockWindowInstances.length = 0;
    const window = createWindowUnderTest();
    const event = { preventDefault: vi.fn() };

    window?.willAttachWebviewHandler?.(
      event,
      {},
      {
        partition: "persist:bigbud-browser",
        src,
      },
    );

    expect(event.preventDefault).toHaveBeenCalledTimes(blocked ? 1 : 0);
  });

  it("forwards native browser navigation commands to the renderer", () => {
    mockWindowInstances.length = 0;
    const window = createWindowUnderTest();
    const appCommand = window?.windowHandlers.get("app-command");

    appCommand?.({}, "browser-backward");
    appCommand?.({}, "browser-forward");
    appCommand?.({}, "media-play-pause");

    expect(window?.webContents.send).toHaveBeenCalledTimes(2);
    expect(window?.webContents.send).toHaveBeenNthCalledWith(
      1,
      "desktop:menu-action",
      "browser-backward",
    );
    expect(window?.webContents.send).toHaveBeenNthCalledWith(
      2,
      "desktop:menu-action",
      "browser-forward",
    );
  });

  it("adds Copy Image for image context menus", () => {
    mockWindowInstances.length = 0;
    buildFromTemplateMock.mockClear();
    popupMock.mockClear();
    buildFromTemplateMock.mockReturnValue({ popup: popupMock });
    const window = createWindowUnderTest();
    expect(window).toBeTruthy();
    const preventDefault = vi.fn();

    window?.contextMenuHandler?.(
      { preventDefault },
      {
        mediaType: "image",
        x: 12,
        y: 34,
        misspelledWord: "",
        dictionarySuggestions: [],
        editFlags: {
          canCut: false,
          canCopy: true,
          canPaste: false,
          canSelectAll: true,
        },
      },
    );

    expect(preventDefault).toHaveBeenCalled();
    const buildCalls = buildFromTemplateMock.mock.calls as unknown as Array<[MenuTemplateEntry[]]>;
    const firstBuildCall = buildCalls[0];
    expect(firstBuildCall).toBeTruthy();
    const menuTemplate = firstBuildCall?.[0];
    expect(menuTemplate).toBeTruthy();
    expect(menuTemplate).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Copy Image" }),
        expect.objectContaining({ role: "copy", enabled: true }),
      ]),
    );

    const copyImageItem = menuTemplate?.find((item) => item.label === "Copy Image");
    expect(copyImageItem).toBeTruthy();
    copyImageItem?.click?.();
    expect(window?.webContents.copyImageAt).toHaveBeenCalledWith(12, 34);
    expect(popupMock).toHaveBeenCalled();
  });

  it("cleans up certificate challenges without reading destroyed window state", () => {
    mockWindowInstances.length = 0;
    closeHostMock.mockClear();
    const window = createWindowUnderTest();
    const originalWebContents = window?.webContents;
    expect(originalWebContents).toBeTruthy();

    Object.defineProperty(window, "webContents", {
      get: () => {
        throw new Error("Object has been destroyed");
      },
    });

    expect(() => window?.windowHandlers.get("closed")?.()).not.toThrow();
    expect(closeHostMock).toHaveBeenCalledWith(originalWebContents);
  });
});
