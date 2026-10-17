import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { FilesDrawerController, type FilesDrawerMode } from "./FilesPanel.drawer.controller";
import { focusFilesTreeDrawer } from "./FilesPanel.drawer.focus";
import { useFilesDrawerEdge } from "./FilesPanel.drawer.edge";

export function useFilesTreeDrawer(input: {
  readonly hasPreview: boolean;
  readonly workspaceKey: string;
  readonly contextMenuOpen: boolean;
  readonly visible: boolean;
}) {
  const enabled = input.visible && input.hasPreview;
  const enabledRef = useRef(enabled);
  const [mode, setMode] = useState<FilesDrawerMode>("closed");
  const [controller] = useState(() => new FilesDrawerController(setMode));
  const drawerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const lastFocusedRowRef = useRef<HTMLButtonElement | null>(null);
  useFilesDrawerEdge({
    enabled,
    controller,
    previewRef,
    drawerRef,
    handleRef,
  });

  useLayoutEffect(() => {
    enabledRef.current = enabled;
    const nextMode = controller.setActive(enabled);
    // Preview/workspace changes may hide the tree. Never move focus from a hidden tab.
    if (enabled && nextMode !== "pinned" && drawerRef.current?.contains(document.activeElement)) {
      previewRef.current?.focus({ preventScroll: true });
    }
  }, [controller, enabled, input.hasPreview, input.workspaceKey]);

  useLayoutEffect(() => {
    lastFocusedRowRef.current = null;
  }, [input.hasPreview, input.workspaceKey]);

  useEffect(() => {
    controller.setActivity("menu", enabled && input.contextMenuOpen);
  }, [controller, enabled, input.contextMenuOpen, input.workspaceKey]);

  useEffect(() => () => controller.dispose(), [controller]);

  const dismiss = useCallback(() => {
    const restoreFocus =
      drawerRef.current?.contains(document.activeElement) ||
      (document.activeElement instanceof Element &&
        document.activeElement.closest("[data-files-panel-controls]") !== null);
    controller.dismiss();
    if (restoreFocus) {
      requestAnimationFrame(() => {
        if (enabledRef.current) handleRef.current?.focus({ preventScroll: true });
      });
    }
  }, [controller]);

  // Escape must be owned from the drawer's first visible frame, before passive effects.
  useLayoutEffect(() => {
    if (!enabled || mode === "closed" || mode === "pinned") return;
    function handleEscape(event: KeyboardEvent) {
      // Let portalled menus and preview controls consume Escape first.
      if (
        !enabledRef.current ||
        event.key !== "Escape" ||
        event.defaultPrevented ||
        input.contextMenuOpen
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [dismiss, enabled, input.contextMenuOpen, mode]);

  useEffect(() => {
    if (!enabled) return;
    function endInteraction() {
      controller.setActivity("interaction", false);
    }
    function endDrag() {
      controller.setActivity("drag", false);
    }
    function endAllInteractions() {
      endInteraction();
      endDrag();
    }
    window.addEventListener("pointerup", endInteraction);
    window.addEventListener("pointercancel", endInteraction);
    window.addEventListener("dragend", endDrag);
    window.addEventListener("drop", endDrag);
    window.addEventListener("blur", endAllInteractions);
    return () => {
      window.removeEventListener("pointerup", endInteraction);
      window.removeEventListener("pointercancel", endInteraction);
      window.removeEventListener("dragend", endDrag);
      window.removeEventListener("drop", endDrag);
      window.removeEventListener("blur", endAllInteractions);
    };
  }, [controller, enabled]);

  function focusOpenedTree() {
    requestAnimationFrame(() => {
      if (enabledRef.current && drawerRef.current)
        focusFilesTreeDrawer(drawerRef.current, lastFocusedRowRef.current, handleRef.current);
    });
  }

  return {
    mode,
    drawerRef,
    handleRef,
    previewRef,
    dismiss,
    open: () => {
      if (!enabledRef.current) return;
      controller.open();
      focusOpenedTree();
    },
    toggle: () => {
      if (!enabledRef.current) return;
      if (controller.toggle()) focusOpenedTree();
      else {
        requestAnimationFrame(() => {
          if (enabledRef.current) handleRef.current?.focus({ preventScroll: true });
        });
      }
    },
    togglePin: () => controller.togglePin(),
    enterHandle: () => controller.enterHandle(),
    leaveHandle: () => controller.setTrigger("header", false),
    enterDrawer: () => controller.setActivity("pointer", true),
    leave: () => controller.setActivity("pointer", false),
    focus: (event: React.FocusEvent<HTMLElement>) => {
      const target = event.target;
      if (target instanceof HTMLButtonElement && target.closest("[data-files-tree-scroll]")) {
        lastFocusedRowRef.current = target;
      }
      controller.setActivity("focus", true);
    },
    blur: (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      const next = event.relatedTarget;
      if (next && (drawerRef.current?.contains(next) || handleRef.current === next)) return;
      controller.setActivity("focus", false);
    },
    startInteraction: () => controller.setActivity("interaction", true),
    startDrag: () => controller.setActivity("drag", true),
  };
}
