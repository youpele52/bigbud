import type { ContextMenuItem } from "@bigbud/contracts";

import { copyTextToClipboard } from "~/lib/clipboard/copyText";
import { openPathInPreferredApp } from "~/models/editor/fileOpen.models";
import { ensureNativeApi } from "~/rpc/nativeApi";
import { createSharedFileActionItems, type SharedFileActionId } from "./FileActionsMenu.shared";

export type FilePreviewContextMenuAction =
  | "copy-selected-text"
  | "annotate-selection"
  | SharedFileActionId;

interface CreateFilePreviewContextMenuItemsInput {
  readonly hasSelectedText: boolean;
  readonly canSelectAll: boolean;
  readonly canAnnotateSelection: boolean;
}

interface RunFilePreviewContextMenuActionInput {
  readonly action: FilePreviewContextMenuAction | null;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly selectedText: string;
  readonly onAnnotateSelection?: (() => void) | undefined;
  readonly onSelectAll?: (() => void) | undefined;
}

interface ShowFilePreviewContextMenuInput {
  readonly position: { x: number; y: number };
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly selectedText: string;
  readonly canSelectAll: boolean;
  readonly onAnnotateSelection?: (() => void) | undefined;
  readonly onSelectAll?: (() => void) | undefined;
}

export function createFilePreviewContextMenuItems(
  input: CreateFilePreviewContextMenuItemsInput,
): ReadonlyArray<ContextMenuItem<FilePreviewContextMenuAction>> {
  return [
    ...(input.hasSelectedText ? [{ id: "copy-selected-text" as const, label: "Copy" }] : []),
    ...createSharedFileActionItems({
      canSelectAll: input.canSelectAll,
      canOpenExternally: true,
      canCopyRelativePath: true,
      canCopyPath: true,
    }),
    ...(input.canAnnotateSelection
      ? [{ id: "annotate-selection" as const, label: "Annotate selection" }]
      : []),
  ];
}

export function selectElementContents(element: HTMLElement | null): void {
  if (!element) {
    return;
  }

  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

export async function runFilePreviewContextMenuAction(
  input: RunFilePreviewContextMenuActionInput,
): Promise<void> {
  if (!input.action) {
    return;
  }

  if (input.action === "copy-selected-text") {
    await copyTextToClipboard(input.selectedText);
    return;
  }

  if (input.action === "select-all") {
    input.onSelectAll?.();
    return;
  }

  if (input.action === "annotate-selection") {
    input.onAnnotateSelection?.();
    return;
  }

  if (input.action === "open-externally") {
    await openPathInPreferredApp(ensureNativeApi(), input.absolutePath);
    return;
  }

  if (input.action === "copy-relative-path") {
    await copyTextToClipboard(input.relativePath);
    return;
  }

  if (input.action === "copy-path") {
    await copyTextToClipboard(input.absolutePath);
    return;
  }

  await copyTextToClipboard(input.absolutePath);
}

export async function showFilePreviewContextMenu(
  input: ShowFilePreviewContextMenuInput,
): Promise<void> {
  const action = await ensureNativeApi().contextMenu.show(
    createFilePreviewContextMenuItems({
      hasSelectedText: input.selectedText.length > 0,
      canSelectAll: input.canSelectAll,
      canAnnotateSelection: Boolean(input.onAnnotateSelection),
    }),
    input.position,
  );

  await runFilePreviewContextMenuAction({
    action,
    absolutePath: input.absolutePath,
    relativePath: input.relativePath,
    selectedText: input.selectedText,
    onAnnotateSelection: input.onAnnotateSelection,
    onSelectAll: input.onSelectAll,
  });
}
