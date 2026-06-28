import { beforeEach, describe, expect, it, vi } from "vitest";

const { contextMenuShowMock, copyTextToClipboardMock } = vi.hoisted(() => ({
  contextMenuShowMock: vi.fn(),
  copyTextToClipboardMock: vi.fn(),
}));

vi.mock("~/rpc/nativeApi", () => ({
  ensureNativeApi: () => ({
    contextMenu: {
      show: contextMenuShowMock,
    },
  }),
}));

vi.mock("~/lib/clipboard/copyText", () => ({
  copyTextToClipboard: copyTextToClipboardMock,
}));

import { showGitChangedFileCopyMenu, showGitCommitCopyMenu } from "./GitPanel.copy";

describe("GitPanel.copy", () => {
  beforeEach(() => {
    contextMenuShowMock.mockReset();
    copyTextToClipboardMock.mockReset();
    vi.stubGlobal("window", {
      getSelection: () => ({
        toString: () => "",
      }),
    });
  });

  it("shows commit copy actions and copies the full sha", async () => {
    contextMenuShowMock.mockResolvedValue("copy-sha");

    await showGitCommitCopyMenu({
      commit: {
        sha: "be9f1ab52cafe1234",
        shortSha: "be9f1ab52",
        subject: "Update CHANGELOG.md",
        authors: [
          { name: "Youpele Michael", email: "mjayjesus@gmail.com" },
          { name: "Cursor", email: "cursoragent@cursor.com" },
        ],
        authoredAt: "2026-06-18T10:00:00.000Z",
        isPushed: true,
        tags: ["stable"],
      },
      position: { x: 24, y: 32 },
    });

    expect(contextMenuShowMock).toHaveBeenCalledWith(
      [
        { id: "copy-subject", label: "Copy Subject" },
        { id: "copy-sha", label: "Copy SHA" },
        { id: "copy-tags", label: "Copy Tags", disabled: false },
        { id: "copy-author", label: "Copy Authors" },
        { id: "copy-body", label: "Copy Body", disabled: true },
      ],
      { x: 24, y: 32 },
    );
    expect(copyTextToClipboardMock).toHaveBeenCalledWith("be9f1ab52cafe1234");
  });

  it("offers selected text copy before commit metadata actions", async () => {
    vi.stubGlobal("window", {
      getSelection: () => ({
        toString: () => "selected body text",
      }),
    });
    contextMenuShowMock.mockResolvedValue("copy-selected-text");

    await showGitCommitCopyMenu({
      commit: {
        sha: "be9f1ab52cafe1234",
        shortSha: "be9f1ab52",
        subject: "Update CHANGELOG.md",
        authors: [{ name: "Youpele Michael", email: "mjayjesus@gmail.com" }],
        authoredAt: "2026-06-18T10:00:00.000Z",
        body: "Body text",
        parents: [],
        files: [],
        diff: "",
        tags: [],
      },
      body: "Body text",
      position: { x: 11, y: 12 },
    });

    expect(contextMenuShowMock).toHaveBeenCalledWith(
      expect.arrayContaining([{ id: "copy-selected-text", label: "Copy Selected Text" }]),
      { x: 11, y: 12 },
    );
    expect(copyTextToClipboardMock).toHaveBeenCalledWith("selected body text");
  });

  it("copies joined author names for co-authored commits", async () => {
    contextMenuShowMock.mockResolvedValue("copy-author");

    await showGitCommitCopyMenu({
      commit: {
        sha: "be9f1ab52cafe1234",
        shortSha: "be9f1ab52",
        subject: "Update CHANGELOG.md",
        authors: [
          { name: "Youpele Michael", email: "mjayjesus@gmail.com" },
          { name: "Cursor", email: "cursoragent@cursor.com" },
        ],
        authoredAt: "2026-06-18T10:00:00.000Z",
        isPushed: true,
        tags: [],
      },
      position: { x: 11, y: 12 },
    });

    expect(copyTextToClipboardMock).toHaveBeenCalledWith("Youpele Michael, Cursor");
  });

  it("shows changed file copy actions and copies the filename", async () => {
    contextMenuShowMock.mockResolvedValue("copy-filename");

    await showGitChangedFileCopyMenu({
      path: "docs/CHANGELOG.md",
      position: { x: 6, y: 9 },
    });

    expect(contextMenuShowMock).toHaveBeenCalledWith(
      [
        { id: "copy-path", label: "Copy Path" },
        { id: "copy-filename", label: "Copy Filename" },
      ],
      { x: 6, y: 9 },
    );
    expect(copyTextToClipboardMock).toHaveBeenCalledWith("CHANGELOG.md");
  });
});
