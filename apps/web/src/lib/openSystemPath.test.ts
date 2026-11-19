import type { DesktopShellPathResult } from "@bigbud/contracts/server/ipc.desktopShellPath.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inAppViewerFor, openWithSystemDefault, revealInFileManager } from "./openSystemPath";

function bridgeReturning(result: DesktopShellPathResult | null) {
  return {
    openPath: vi.fn(async (_path: string) => result),
    showItemInFolder: vi.fn(async (_path: string) => result),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("inAppViewerFor", () => {
  it.each([
    ["/w/spec.PDF", { panel: "browser", format: "pdf" }],
    ["/w/site/index.html", { panel: "browser", format: "html" }],
    ["/w/logo.svg", { panel: "browser", format: "image" }],
    ["/w/clip.mov", { panel: "files", format: "video" }],
    ["/w/analysis.ipynb", { panel: "files", format: "notebook" }],
    ["/w/README.md", { panel: "files", format: "markdown" }],
    ["/w/src/main.ts", { panel: "files", format: "text" }],
    ["/w/Makefile", { panel: "files", format: "text" }],
    ["C:\\w\\notes.txt", { panel: "files", format: "text" }],
  ])("routes %s in-app", (path, expected) => {
    expect(inAppViewerFor(path)).toEqual(expected);
  });

  it.each([
    "/w/report.docx",
    "/w/budget.XLSX",
    "/w/song.mp3",
    "/w/backup.zip",
    "/w/font.woff2",
    "/w/setup.exe",
    "/w/Thing.app",
    "/w/photo.heic",
    "/w/data.sqlite",
  ])("sends %s to the system default app", (path) => {
    expect(inAppViewerFor(path)).toBeNull();
  });
});

describe("openWithSystemDefault", () => {
  it("reports opened when the desktop shell opened the file", async () => {
    const bridge = bridgeReturning({ status: "opened" });
    await expect(openWithSystemDefault("/w/report.docx", bridge)).resolves.toEqual({
      kind: "opened",
    });
    expect(bridge.openPath).toHaveBeenCalledExactlyOnceWith("/w/report.docx");
    expect(bridge.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reports revealed-instead when the shell downgraded a launchable path", async () => {
    const bridge = bridgeReturning({ status: "revealed", launchable: true });
    await expect(openWithSystemDefault("/w/setup.sh", bridge)).resolves.toEqual({
      kind: "revealed-instead",
      reason: "launchable",
    });
  });

  it("passes refusals through with the OS message", async () => {
    await expect(
      openWithSystemDefault(
        "/w/a.xyz",
        bridgeReturning({ status: "refused", reason: "open-failed", message: "No app" }),
      ),
    ).resolves.toEqual({ kind: "refused", reason: "open-failed", message: "No app" });
    await expect(
      openWithSystemDefault("/w/gone", bridgeReturning({ status: "refused", reason: "not-found" })),
    ).resolves.toEqual({ kind: "refused", reason: "not-found" });
  });

  it("treats a denied (null) answer as unauthorized", async () => {
    await expect(openWithSystemDefault("/w/a.docx", bridgeReturning(null))).resolves.toEqual({
      kind: "refused",
      reason: "unauthorized",
    });
  });

  it("refuses relative paths before any IPC", async () => {
    const bridge = bridgeReturning({ status: "opened" });
    for (const path of ["a.docx", "./a.docx", "~/a.docx"]) {
      await expect(openWithSystemDefault(path, bridge)).resolves.toEqual({
        kind: "refused",
        reason: "invalid-path",
      });
    }
    expect(bridge.openPath).not.toHaveBeenCalled();
  });

  it("maps a rejected IPC call to open-failed", async () => {
    const bridge = {
      openPath: vi.fn(async () => {
        throw new Error("ipc gone");
      }),
    };
    await expect(openWithSystemDefault("/w/a.docx", bridge)).resolves.toEqual({
      kind: "refused",
      reason: "open-failed",
      message: "ipc gone",
    });
  });

  it("is unavailable without a desktop bridge or on an older bridge", async () => {
    vi.stubGlobal("window", {});
    await expect(openWithSystemDefault("/w/a.docx")).resolves.toEqual({
      kind: "unavailable-in-browser",
    });
    await expect(openWithSystemDefault("/w/a.docx", {})).resolves.toEqual({
      kind: "unavailable-in-browser",
    });
  });

  it("uses window.desktopBridge by default", async () => {
    const bridge = bridgeReturning({ status: "opened" });
    vi.stubGlobal("window", { desktopBridge: bridge });
    await expect(openWithSystemDefault("/w/a.docx")).resolves.toEqual({ kind: "opened" });
    expect(bridge.openPath).toHaveBeenCalledOnce();
  });
});

describe("revealInFileManager", () => {
  it("reports revealed for documents and executables alike", async () => {
    for (const launchable of [false, true]) {
      const bridge = bridgeReturning({ status: "revealed", launchable });
      await expect(revealInFileManager("/w/x", bridge)).resolves.toEqual({ kind: "revealed" });
      expect(bridge.showItemInFolder).toHaveBeenCalledExactlyOnceWith("/w/x");
      expect(bridge.openPath).not.toHaveBeenCalled();
    }
  });

  it("is unavailable in the browser and refuses relative paths", async () => {
    vi.stubGlobal("window", {});
    await expect(revealInFileManager("/w/x")).resolves.toEqual({
      kind: "unavailable-in-browser",
    });
    await expect(
      revealInFileManager("x", bridgeReturning({ status: "revealed", launchable: false })),
    ).resolves.toEqual({ kind: "refused", reason: "invalid-path" });
  });
});
