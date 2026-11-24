import type { ContextMenuItem, GitDiscardSelection } from "@bigbud/contracts";

export type GitChangedFileMenuAction =
  | "discard-file"
  | "discard-all"
  | "copy-selected-text"
  | "copy-path"
  | "copy-filename";

/** What the user asked to discard; `paths` are exactly the files the panel listed. */
export type GitDiscardRequest = GitDiscardSelection;

/** Copy actions first, a divider, then the discard actions (no destructive trash icon). */
export function buildGitChangedFileMenuItems(input: {
  readonly selectedText: string;
}): ContextMenuItem<GitChangedFileMenuAction | "separator-discard">[] {
  return [
    ...(input.selectedText
      ? [{ id: "copy-selected-text" as const, label: "Copy Selected Text" }]
      : []),
    { id: "copy-path", label: "Copy Path" },
    { id: "copy-filename", label: "Copy Filename" },
    { id: "separator-discard", label: "", separator: true },
    { id: "discard-file", label: "Discard changes" },
    { id: "discard-all", label: "Discard all changes" },
  ];
}

export function buildGitDiscardRequest(input: {
  readonly action: "discard-file" | "discard-all";
  readonly path: string;
  readonly listedPaths: ReadonlyArray<string>;
}): GitDiscardRequest {
  return input.action === "discard-file"
    ? { scope: "paths", paths: [input.path] }
    : { scope: "all", paths: [...input.listedPaths] };
}

export interface GitDiscardConfirmationCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

export function describeGitDiscardConfirmation(
  request: GitDiscardRequest,
  options: { readonly isRemote: boolean },
): GitDiscardConfirmationCopy {
  const removal = options.isRemote
    ? "New untracked files are deleted."
    : "New untracked files are moved to the Trash where available, otherwise deleted.";
  if (request.scope === "paths" && request.paths.length === 1) {
    return {
      title: `Discard changes to ${request.paths[0]}?`,
      description: `The file is restored to the last commit, including staged changes. ${removal} This cannot be undone.`,
      confirmLabel: "Discard changes",
    };
  }
  const count = request.paths.length;
  return {
    title: `Discard all changes to ${count} file${count === 1 ? "" : "s"}?`,
    description: `Only the files listed in the Git panel are restored to the last commit, including staged changes. ${removal} This cannot be undone.`,
    confirmLabel: "Discard all changes",
  };
}
