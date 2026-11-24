import type { GitCommitSummary, GitGetCommitDetailsResult } from "@bigbud/contracts";

import { copyTextToClipboard } from "~/lib/clipboard/copyText";
import { ensureNativeApi } from "~/rpc/nativeApi";
import {
  buildGitChangedFileMenuItems,
  buildGitDiscardRequest,
  type GitDiscardRequest,
} from "./GitPanel.discard.logic";
import { formatGitCommitAuthorNames } from "./GitPanelAuthors";

type GitCommitCopyAction =
  | "copy-selected-text"
  | "copy-subject"
  | "copy-sha"
  | "copy-tags"
  | "copy-author"
  | "copy-body";

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
      {
        id: "copy-author",
        label: input.commit.authors.length > 1 ? "Copy Authors" : "Copy Author",
      },
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
    await copyTextToClipboard(formatGitCommitAuthorNames(input.commit.authors));
    return;
  }
  await copyTextToClipboard((input.body ?? "").trim());
}

/** Shows the changed-file menu; discard actions are handed to `onDiscard` for confirmation. */
export async function showGitChangedFileCopyMenu(input: {
  path: string;
  listedPaths: ReadonlyArray<string>;
  position: { x: number; y: number };
  onDiscard: (request: GitDiscardRequest) => void;
}): Promise<void> {
  const selectedText = readSelectedText();
  const action = await ensureNativeApi().contextMenu.show(
    buildGitChangedFileMenuItems({ selectedText }),
    input.position,
  );
  if (!action || action === "separator-discard") {
    return;
  }

  if (action === "discard-file" || action === "discard-all") {
    input.onDiscard(
      buildGitDiscardRequest({ action, path: input.path, listedPaths: input.listedPaths }),
    );
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
