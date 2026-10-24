import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { showBrowserFeedback } from "./browserFeedback";

const mocks = vi.hoisted(() => ({ dialog: vi.fn(), external: vi.fn() }));
vi.mock("electron", () => ({
  dialog: { showMessageBox: mocks.dialog },
  shell: { openExternal: mocks.external },
}));
beforeEach(() => vi.clearAllMocks());

describe("browser failure feedback", () => {
  it("opens only safe HTTP(S) URLs after explicit native confirmation", async () => {
    const owner = { isDestroyed: () => false } as BrowserWindow;
    mocks.dialog.mockResolvedValue({ response: 1 });
    await showBrowserFeedback(owner, "Blocked", "https://site.example/login");
    expect(mocks.dialog.mock.calls[0]![1]).toMatchObject({ defaultId: 0, cancelId: 0 });
    expect(mocks.dialog.mock.calls[0]![1].detail).toContain("does not transfer cookies");
    expect(mocks.dialog.mock.calls[0]![1].detail).toContain("Site: https://site.example");
    expect(mocks.external).toHaveBeenCalledWith("https://site.example/login");
  });

  it.each(["file:///secret", "javascript:alert(1)", "custom:thing"])(
    "never launches blocked scheme %s",
    async (url) => {
      mocks.dialog.mockResolvedValue({ response: 1 });
      await showBrowserFeedback({ isDestroyed: () => false } as BrowserWindow, "Blocked", url);
      expect(mocks.external).not.toHaveBeenCalled();
      expect(mocks.dialog.mock.calls[0]![1].buttons).toEqual(["Close"]);
    },
  );

  it("does not launch on dismissal and rate-limits repeated remote feedback", async () => {
    const owner = { isDestroyed: () => false } as BrowserWindow;
    mocks.dialog.mockResolvedValue({ response: 0 });
    await showBrowserFeedback(owner, "Blocked", "https://site.example/");
    await showBrowserFeedback(owner, "Blocked again", "https://site.example/");
    expect(mocks.external).not.toHaveBeenCalled();
    expect(mocks.dialog).toHaveBeenCalledOnce();
    await showBrowserFeedback(owner, "Manual fallback", "https://site.example/", true);
    expect(mocks.dialog).toHaveBeenCalledTimes(2);
  });

  it("handles dialog and launcher errors without an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.dialog.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      showBrowserFeedback(
        { isDestroyed: () => false } as BrowserWindow,
        "Blocked",
        "https://site.example/",
      ),
    ).resolves.toBeUndefined();
    mocks.dialog.mockResolvedValueOnce({ response: 1 });
    mocks.external.mockRejectedValueOnce(new Error("no browser"));
    await expect(
      showBrowserFeedback(
        { isDestroyed: () => false } as BrowserWindow,
        "Blocked",
        "https://site.example/",
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
