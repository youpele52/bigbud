export type FileTargetMenuItemId =
  | "open-in-browser"
  | "open-in-file-viewer"
  | "open-internally"
  | "open-externally"
  | "copy-relative-path"
  | "copy-path"
  | "capture-checkpoint"
  | "delete"
  | "restore-checkpoint";

export interface FileTargetMenuItem {
  readonly id: FileTargetMenuItemId;
  readonly label: string;
  readonly destructive?: boolean;
  /** Why the item is disabled (shown to the user); absent when enabled. */
  readonly disabledReason?: string;
}

export interface FileTargetMenuInput {
  readonly canOpenInBrowser: boolean;
  readonly canOpenInFileViewer: boolean;
  readonly canOpenDirectoryInternally: boolean;
  readonly canOpenExternally: boolean;
  readonly canCopyRelativePath: boolean;
  readonly canCopyPath: boolean;
  readonly canUsePathCheckpoints: boolean;
  /** Undefined hides Delete (surfaces without delete support); null means enabled. */
  readonly deleteDisabledReason?: string | null | undefined;
}

/**
 * Items grouped for dividers: open | copy | capture | destructive. Delete sits right before
 * Restore path checkpoint so both destructive actions stay together. Empty groups are dropped.
 */
export function buildFileTargetMenuGroups(
  input: FileTargetMenuInput,
): ReadonlyArray<ReadonlyArray<FileTargetMenuItem>> {
  const open: FileTargetMenuItem[] = [];
  if (input.canOpenInBrowser) open.push({ id: "open-in-browser", label: "Open in browser" });
  if (input.canOpenInFileViewer) {
    open.push({ id: "open-in-file-viewer", label: "Open in file viewer" });
  }
  if (input.canOpenDirectoryInternally) {
    open.push({ id: "open-internally", label: "Open internally" });
  }
  if (input.canOpenExternally) open.push({ id: "open-externally", label: "Open externally" });

  const copy: FileTargetMenuItem[] = [];
  if (input.canCopyRelativePath) {
    copy.push({ id: "copy-relative-path", label: "Copy relative path" });
  }
  if (input.canCopyPath) copy.push({ id: "copy-path", label: "Copy path" });

  const capture: FileTargetMenuItem[] = input.canUsePathCheckpoints
    ? [{ id: "capture-checkpoint", label: "Capture path checkpoint" }]
    : [];

  const destructive: FileTargetMenuItem[] = [];
  if (input.deleteDisabledReason !== undefined) {
    destructive.push({
      id: "delete",
      label: "Delete…",
      destructive: true,
      ...(input.deleteDisabledReason ? { disabledReason: input.deleteDisabledReason } : {}),
    });
  }
  if (input.canUsePathCheckpoints) {
    destructive.push({
      id: "restore-checkpoint",
      label: "Restore path checkpoint",
      destructive: true,
    });
  }
  return [open, copy, capture, destructive].filter((group) => group.length > 0);
}
