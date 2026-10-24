import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, Session, WebContents } from "electron";
import { installBrowserPermissions, registerBrowserPermissionOwner } from "./browserPermissions";

const mocks = vi.hoisted(() => ({ prompt: vi.fn(), feedback: vi.fn() }));
vi.mock("electron", () => ({ dialog: { showMessageBox: mocks.prompt } }));
vi.mock("./browserFeedback", () => ({ showBrowserFeedback: mocks.feedback }));

function setup() {
  const session = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
  const owner = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false) });
  const contents = Object.assign(new EventEmitter(), {
    session,
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => "https://site.example/page"),
  });
  registerBrowserPermissionOwner(
    owner as unknown as BrowserWindow,
    contents as unknown as WebContents,
  );
  installBrowserPermissions(session as unknown as Session);
  const request = session.setPermissionRequestHandler.mock.calls[0]![0];
  const check = session.setPermissionCheckHandler.mock.calls[0]![0];
  const callback = vi.fn();
  const details = { isMainFrame: true, requestingUrl: contents.getURL(), mediaTypes: ["audio"] };
  return { owner, contents, session, request, check, callback, details };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.prompt.mockReset();
  mocks.feedback.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("browser site consent", () => {
  it("prompts with the real origin, denies by default, then scopes consent by tab, origin and capability", async () => {
    const { contents, request, check, callback, details, session } = setup();
    mocks.prompt.mockResolvedValue({ response: 1 });
    expect(
      check(contents, "media", "https://site.example", { isMainFrame: true, mediaType: "audio" }),
    ).toBe(false);
    request(contents, "media", callback, details);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true));
    expect(mocks.prompt.mock.calls[0]![1]).toMatchObject({
      message: "Allow https://site.example to access microphone?",
      defaultId: 0,
      cancelId: 0,
    });
    const checkDetails = { isMainFrame: true, mediaType: "audio" };
    expect(check(contents, "media", "https://site.example", checkDetails)).toBe(true);
    expect(check(contents, "media", "https://other.example", checkDetails)).toBe(false);
    expect(
      check(contents, "media", "https://site.example", { ...checkDetails, mediaType: "video" }),
    ).toBe(false);
    expect(
      check(contents, "media", "https://site.example", { ...checkDetails, isMainFrame: false }),
    ).toBe(false);
    expect(check(null, "media", "https://site.example", checkDetails)).toBe(false);
    const secondTab = { ...contents, session, isDestroyed: () => false, getURL: contents.getURL };
    expect(check(secondTab, "media", "https://site.example", checkDetails)).toBe(false);
    request(contents, "media", callback, details);
    expect(mocks.prompt).toHaveBeenCalledOnce();
    contents.getURL.mockReturnValue("https://other.example/");
    expect(check(contents, "media", "https://site.example", checkDetails)).toBe(false);
  });

  it.each([
    ["media", { mediaTypes: ["audio", "video"] }, "microphone and camera"],
    ["geolocation", {}, "location"],
    ["notifications", {}, "notifications"],
  ])("asks explicitly for %s", async (permission, extra, label) => {
    const { contents, request, callback, details } = setup();
    mocks.prompt.mockResolvedValue({ response: 1 });
    request(contents, permission, callback, { ...details, ...extra });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true));
    expect(mocks.prompt.mock.calls[0]![1].message).toContain(label);
  });

  it("remembers denial only for the requested capability in that tab", async () => {
    const { contents, request, callback, details } = setup();
    mocks.prompt.mockResolvedValue({ response: 0 });
    request(contents, "media", callback, details);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false));
    request(contents, "media", callback, details);
    expect(mocks.prompt).toHaveBeenCalledOnce();
    request(contents, "media", callback, { ...details, mediaTypes: ["video"] });
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["display-capture", {}],
    ["clipboard-read", {}],
    ["unknown", {}],
    ["media", { mediaTypes: [] }],
    ["media", { mediaTypes: ["unknown"] }],
    ["media", { requestingUrl: "https://other.example/" }],
    ["media", { requestingUrl: "file:///private/secret" }],
    ["media", { isMainFrame: false }],
  ])("denies unsupported or untrusted requests: %s %j", (permission, extra) => {
    const { contents, request, callback, details } = setup();
    request(contents, permission, callback, { ...details, ...extra });
    expect(callback).toHaveBeenCalledWith(false);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.feedback).toHaveBeenCalledOnce();
  });

  it.each(["navigation", "destroyed", "closed", "timeout"])(
    "rejects stale consent after %s and completes exactly once",
    async (reason) => {
      const { contents, owner, request, callback, details } = setup();
      let respond!: (value: { response: number }) => void;
      mocks.prompt.mockImplementation(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      );
      request(contents, "media", callback, details);
      const signal = mocks.prompt.mock.calls[0]![1].signal as AbortSignal;
      if (reason === "navigation")
        contents.emit("did-start-navigation", {}, "https://other.example", false, true);
      if (reason === "destroyed") contents.emit("destroyed");
      if (reason === "closed") owner.emit("closed");
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(60_000);
      expect(callback).toHaveBeenCalledExactlyOnceWith(false);
      expect(signal.aborted).toBe(true);
      respond({ response: 1 });
      await Promise.resolve();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(contents.listenerCount("did-start-navigation")).toBe(0);
    },
  );

  it("bounds concurrent prompts and fails closed on native dialog failure", async () => {
    const { contents, request, callback, details } = setup();
    mocks.prompt.mockRejectedValue(new Error("dialog unavailable"));
    request(contents, "media", callback, details);
    const second = vi.fn();
    request(contents, "geolocation", second, details);
    expect(second).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false));
    expect(mocks.prompt).toHaveBeenCalledOnce();
  });

  it("rejects workers, unregistered app contents and wrong partitions without prompting", () => {
    const { contents, request, callback, details } = setup();
    request({ ...contents }, "media", callback, details);
    contents.session = {} as typeof contents.session;
    request(contents, "media", callback, details);
    expect(callback.mock.calls).toEqual([[false], [false]]);
    expect(mocks.prompt).not.toHaveBeenCalled();
  });
});
