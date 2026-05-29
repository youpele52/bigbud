import { describe, expect, it, vi } from "vitest";

import { createWindow } from "./windowManager";

const { buildFromTemplateMock, mockWindowInstances, popupMock } = vi.hoisted(() => ({
  popupMock: vi.fn(),
  buildFromTemplateMock: vi.fn(() => ({ popup: vi.fn() })),
  mockWindowInstances: [] as Array<any>,
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
      }),
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      loadURL: vi.fn(),
      replaceMisspelling: vi.fn(),
      copyImageAt: vi.fn(),
    };
    on = vi.fn();
    once = vi.fn();
    show = vi.fn();
    setTitle = vi.fn();
    loadURL = vi.fn();
    contextMenuHandler: ((event: { preventDefault: () => void }, params: any) => void) | null =
      null;
  }

  return {
    BrowserWindow: MockBrowserWindow,
    Menu: {
      buildFromTemplate: buildFromTemplateMock,
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
    spellcheckEnabled: true,
    resolveIconPath: () => null,
    getSafeExternalUrl: () => null,
    emitUpdateState: () => undefined,
    onWindowClosed: () => undefined,
  });

  return mockWindowInstances.at(-1) ?? null;
}

describe("windowManager context menu", () => {
  it("passes spellcheck through to webPreferences", () => {
    mockWindowInstances.length = 0;

    createWindow({
      appDisplayName: "bigbud",
      desktopScheme: "bigbud",
      isDevelopment: false,
      desktopDir: "/desktop",
      spellcheckEnabled: false,
      resolveIconPath: () => null,
      getSafeExternalUrl: () => null,
      emitUpdateState: () => undefined,
      onWindowClosed: () => undefined,
    });

    const window = mockWindowInstances.at(-1);
    expect(window?.options).toMatchObject({
      webPreferences: expect.objectContaining({
        spellcheck: false,
      }),
    });
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
});
