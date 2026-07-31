import type { RefObject } from "react";
import type { ThreadId } from "@bigbud/contracts";

import { copyTextToClipboard } from "~/lib/clipboard/copyText";
import { useComposerDraftStore } from "~/stores/composer";
import { toastManager } from "../ui/toast";
import type { BrowserContextMenuContext } from "./BrowserPanel.contextMenu.hook";
import type { BrowserViewportRef } from "./BrowserPanel.viewport";
import type { ContextMenuItem } from "./BrowserPanel.contextMenu";

interface BrowserContextMenuItemsInput {
  canGoBack: boolean;
  canGoForward: boolean;
  context: BrowserContextMenuContext | null;
  currentUrl: string;
  activeThreadId: ThreadId | null | undefined;
  viewportRef: RefObject<BrowserViewportRef | null>;
  onOpenNewTab: (url: string) => void;
}

function normalizeHttpUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function addToast(type: "error" | "success", title: string) {
  toastManager.add({ type, title });
}

function copyText(text: string, label: string) {
  void copyTextToClipboard(text).then(
    () => addToast("success", `${label} copied`),
    () => addToast("error", `Unable to copy ${label.toLowerCase()}`),
  );
}

function openExternal(url: string | null) {
  if (!url) return;
  if (window.desktopBridge?.openExternal) {
    void window.desktopBridge
      .openExternal(url)
      .catch(() => addToast("error", "Unable to open link"));
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function sendSelectionToChat(threadId: ThreadId | null | undefined, selection: string) {
  if (!threadId) return;
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  const nextPrompt = draft?.prompt ? `${draft.prompt}\n\n${selection}` : selection;
  useComposerDraftStore.getState().setPrompt(threadId, nextPrompt);
  addToast("success", "Selection added to chat");
}

function separator(id: string): ContextMenuItem {
  return { id, label: "", separator: true, onClick: () => undefined };
}

export function createBrowserContextMenuItems(
  input: BrowserContextMenuItemsInput,
): ContextMenuItem[] {
  const { context, currentUrl, viewportRef } = input;
  const pageUrl = normalizeHttpUrl(context?.pageURL) ?? normalizeHttpUrl(currentUrl);
  const linkUrl = normalizeHttpUrl(context?.linkURL);
  const imageUrl = normalizeHttpUrl(context?.srcURL);
  const selection = context?.selectionText?.trim() ?? "";
  const editFlags = context?.editFlags;
  const items: ContextMenuItem[] = [
    {
      id: "back",
      label: "Back",
      disabled: !input.canGoBack,
      onClick: () => viewportRef.current?.goBack(),
    },
    {
      id: "forward",
      label: "Forward",
      disabled: !input.canGoForward,
      onClick: () => viewportRef.current?.goForward(),
    },
    { id: "reload", label: "Reload", onClick: () => viewportRef.current?.reload() },
  ];

  if (selection && !context?.isEditable) {
    items.push(separator("selection-separator"));
    items.push(
      { id: "copy-selection", label: "Copy", onClick: () => copyText(selection, "Selection") },
      {
        id: "search-selection",
        label: "Search the web",
        onClick: () =>
          input.onOpenNewTab(`https://www.google.com/search?q=${encodeURIComponent(selection)}`),
      },
      {
        id: "send-selection",
        label: "Send to bigbud chat",
        disabled: !input.activeThreadId,
        onClick: () => sendSelectionToChat(input.activeThreadId, selection),
      },
    );
  }

  if (linkUrl) {
    items.push(separator("link-separator"));
    items.push(
      {
        id: "open-link",
        label: "Open link in new tab",
        onClick: () => input.onOpenNewTab(linkUrl),
      },
      {
        id: "open-link-external",
        label: "Open link externally",
        onClick: () => openExternal(linkUrl),
      },
      { id: "copy-link", label: "Copy link", onClick: () => copyText(linkUrl, "Link") },
    );
  }

  if (imageUrl || context?.hasImageContents) {
    items.push(separator("image-separator"));
    items.push({
      id: "copy-image-address",
      label: "Copy image address",
      disabled: !imageUrl,
      onClick: () => imageUrl && copyText(imageUrl, "Image address"),
    });
  }

  if (context?.isEditable && editFlags) {
    items.push(separator("edit-separator"));
    items.push(
      {
        id: "undo",
        label: "Undo",
        disabled: !editFlags.canUndo,
        onClick: () => viewportRef.current?.undo(),
      },
      {
        id: "redo",
        label: "Redo",
        disabled: !editFlags.canRedo,
        onClick: () => viewportRef.current?.redo(),
      },
      {
        id: "cut",
        label: "Cut",
        disabled: !editFlags.canCut,
        onClick: () => viewportRef.current?.cut(),
      },
      {
        id: "copy",
        label: "Copy",
        disabled: !editFlags.canCopy,
        onClick: () => viewportRef.current?.copy(),
      },
      {
        id: "paste",
        label: "Paste",
        disabled: !editFlags.canPaste,
        onClick: () => viewportRef.current?.paste(),
      },
      {
        id: "select-all",
        label: "Select all",
        disabled: !editFlags.canSelectAll,
        onClick: () => viewportRef.current?.selectAll(),
      },
    );
  }

  items.push(separator("page-separator"));
  items.push(
    {
      id: "open-page-external",
      label: "Open in default browser",
      disabled: !pageUrl,
      onClick: () => openExternal(pageUrl),
    },
    {
      id: "copy-page-url",
      label: "Copy page URL",
      disabled: !pageUrl,
      onClick: () => pageUrl && copyText(pageUrl, "Page URL"),
    },
  );

  items.push(separator("developer-separator"));
  items.push({
    id: "inspect",
    label: "Inspect",
    onClick: () => {
      if (context) {
        viewportRef.current?.inspectElement(context.x, context.y);
      } else {
        viewportRef.current?.openDevTools();
      }
    },
  });

  return items;
}
