import type { GitCommitSummary, GitGetCommitDetailsResult } from "@bigbud/contracts";

import { copyTextToClipboard } from "~/lib/clipboard/copyText";
import { ensureNativeApi } from "~/rpc/nativeApi";

type GitCommitCopyAction =
  | "copy-selected-text"
  | "copy-subject"
  | "copy-sha"
  | "copy-tags"
  | "copy-author"
  | "copy-body";

type GitChangedFileCopyAction = "copy-selected-text" | "copy-path" | "copy-filename";

function readSelectedText(): string {
  return window.getSelection()?.toString().trim() ?? "";
}

async function showCopyMenu<T extends string>(
  items: ReadonlyArray<{ id: T; label: string; disabled?: boolean }>,
  position: { x: number; y: number },
): Promise<T | null> {
  const api = ensureNativeApi();
  return api.contextMenu.show(items, position);
}

export async function showGitCommitCopyMenu(input: {
  commit: GitCommitSummary | GitGetCommitDetailsResult["commit"];
  body?: string;
  position: { x: number; y: number };
}): Promise<void> {
  const selectedText = readSelectedText();
  const action = await showCopyMenu<GitCommitCopyAction>(
    [
      ...(selectedText ? [{ id: "copy-selected-text" as const, label: "Copy Selected Text" }] : []),
      { id: "copy-subject", label: "Copy Subject" },
      { id: "copy-sha", label: "Copy SHA" },
      {
        id: "copy-tags",
        label: "Copy Tags",
        disabled: input.commit.tags.length === 0,
      },
      { id: "copy-author", label: "Copy Author" },
      {
        id: "copy-body",
        label: "Copy Body",
        disabled: !(input.body ?? "").trim(),
      },
    ],
    input.position,
  );
  if (!action) {
    return;
  }

  if (action === "copy-selected-text") {
    await copyTextToClipboard(selectedText);
    return;
  }
  if (action === "copy-subject") {
    await copyTextToClipboard(input.commit.subject);
    return;
  }
  if (action === "copy-sha") {
    await copyTextToClipboard(input.commit.sha);
    return;
  }
  if (action === "copy-tags") {
    await copyTextToClipboard(input.commit.tags.join(", "));
    return;
  }
  if (action === "copy-author") {
    await copyTextToClipboard(input.commit.authorName);
    return;
  }
  await copyTextToClipboard((input.body ?? "").trim());
}

export async function showGitChangedFileCopyMenu(input: {
  path: string;
  position: { x: number; y: number };
}): Promise<void> {
  const selectedText = readSelectedText();
  const action = await showCopyMenu<GitChangedFileCopyAction>(
    [
      ...(selectedText ? [{ id: "copy-selected-text" as const, label: "Copy Selected Text" }] : []),
      { id: "copy-path", label: "Copy Path" },
      { id: "copy-filename", label: "Copy Filename" },
    ],
    input.position,
  );
  if (!action) {
    return;
  }

  if (action === "copy-selected-text") {
    await copyTextToClipboard(selectedText);
    return;
  }
  if (action === "copy-path") {
    await copyTextToClipboard(input.path);
    return;
  }

  await copyTextToClipboard(input.path.split("/").at(-1) ?? input.path);
}
