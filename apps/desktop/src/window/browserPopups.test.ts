import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import { bindBrowserPopups } from "./browserPopups";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  feedback: vi.fn(),
  menu: vi.fn(),
  gestures: vi.fn(),
}));
vi.mock("electron", () => ({ Menu: { buildFromTemplate: mocks.menu } }));
vi.mock("./browserPermissions", () => ({ registerBrowserPermissionOwner: mocks.register }));
vi.mock("./browserFeedback", () => ({ showBrowserFeedback: mocks.feedback }));
vi.mock("./browserHistoryGestures", () => ({ bindBrowserHistoryGestures: mocks.gestures }));

function contents() {
  return Object.assign(new EventEmitter(), {
    session: {},
    setWindowOpenHandler: vi.fn(),
    getURL: vi.fn(() => "https://site.example/"),
    isDestroyed: vi.fn(() => false),
    reload: vi.fn(),
  });
}
function window() {
  return Object.assign(new EventEmitter(), {
    webContents: contents(),
    isDestroyed: vi.fn(() => false),
    setMenu: vi.fn(),
    setTitle: vi.fn(),
    destroy: vi.fn(),
    close: vi.fn(),
  });
}
function setup() {
  const owner = window();
  const root = contents();
  bindBrowserPopups(owner as unknown as BrowserWindow, root as unknown as WebContents);
  return { owner, root, open: root.setWindowOpenHandler.mock.calls[0]![0] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.menu.mockReturnValue({ popup: vi.fn() });
});

describe("browser popup boundary", () => {
  it("gates gestures on the window that actually contains each browser guest", () => {
    const { owner, root } = setup();
    expect(mocks.gestures).toHaveBeenCalledWith(owner, root);
    const popup = window();
    root.emit("did-create-window", popup);
    expect(mocks.gestures).toHaveBeenLastCalledWith(popup, popup.webContents);
  });
  it.each(["https://login.example/", "http://localhost:3000/", "about:blank"])(
    "allows real popup semantics for %s with locked-down preferences",
    (url) => {
      const { owner, root, open } = setup();
      const response = open({ url });
      expect(response).toMatchObject({
        action: "allow",
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          parent: owner,
          fullscreenable: false,
          webPreferences: {
            session: root.session,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
          },
        },
      });
      expect(response.overrideBrowserWindowOptions.webPreferences).not.toHaveProperty("preload");
    },
  );

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,no",
    "bigbud://app",
    "mailto:a@b.com",
  ])("denies %s with feedback, never an external launch", (url) => {
    const { open } = setup();
    expect(open({ url })).toEqual({ action: "deny" });
    expect(mocks.feedback).toHaveBeenCalledOnce();
  });

  it("binds recursive policy and permission ownership, bounds descendants, and releases slots", () => {
    const { owner, root, open } = setup();
    const popup = window();
    root.emit("did-create-window", popup);
    expect(mocks.register).toHaveBeenCalledWith(owner, popup.webContents, root);
    expect(popup.setMenu).toHaveBeenCalledWith(null);
    const nested = popup.webContents.setWindowOpenHandler.mock.calls[0]![0];
    expect(nested({ url: "file:///secret" })).toEqual({ action: "deny" });
    popup.webContents.emit("did-create-window", window());
    root.emit("did-create-window", window());
    expect(open({ url: "https://site.example/" })).toEqual({ action: "deny" });
    expect(nested({ url: "https://site.example/" })).toEqual({ action: "deny" });
    popup.emit("closed");
    expect(open({ url: "https://site.example/" }).action).toBe("allow");
  });

  it("keeps origin visible, blocks unsafe redirects, reports main-frame failures and offers context-menu fallback", () => {
    const { owner, root } = setup();
    const popup = window();
    root.emit("did-create-window", popup);
    const event = { preventDefault: vi.fn() };
    popup.emit("page-title-updated", event, "A trusted app");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(popup.setTitle).toHaveBeenLastCalledWith("bigbud browser — https://site.example");
    popup.webContents.emit("will-redirect", event, "file:///secret", false, true);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    mocks.feedback.mockClear();
    popup.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://login.example/", true);
    popup.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://login.example/",
      false,
    );
    expect(mocks.feedback).not.toHaveBeenCalled();
    popup.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://login.example/",
      true,
    );
    expect(mocks.feedback).toHaveBeenCalledWith(
      owner,
      expect.stringContaining("ERR_NAME_NOT_RESOLVED"),
      "https://login.example/",
      root,
    );
    popup.webContents.emit("context-menu");
    const item = mocks.menu.mock.calls[0]![0][0];
    expect(item.label).toBe("Open in default browser");
    item.click();
    expect(mocks.feedback).toHaveBeenLastCalledWith(
      owner,
      expect.any(String),
      "https://site.example/",
      "user",
    );
  });

  it.each(["root", "owner"])("destroys descendants when %s closes", (source) => {
    const { root, owner } = setup();
    const popup = window();
    root.emit("did-create-window", popup);
    if (source === "root") root.emit("destroyed");
    else owner.emit("closed");
    expect(popup.destroy).toHaveBeenCalledOnce();
  });

  it("offers an external fallback for rejected popup certificates without bypassing validation", () => {
    const { owner, root } = setup();
    const popup = window();
    root.emit("did-create-window", popup);
    popup.webContents.emit(
      "did-fail-load",
      {},
      -202,
      "ERR_CERT_AUTHORITY_INVALID",
      "https://login.example/",
      true,
    );
    expect(mocks.feedback).toHaveBeenCalledWith(
      owner,
      expect.stringContaining("ERR_CERT_AUTHORITY_INVALID"),
      "https://login.example/",
      root,
    );
  });
});
