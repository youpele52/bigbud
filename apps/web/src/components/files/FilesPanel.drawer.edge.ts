import { useEffect, type RefObject } from "react";

import type { FilesDrawerController } from "./FilesPanel.drawer.controller";

export const FILES_DRAWER_EDGE_WIDTH = 10;

function containsPoint(element: HTMLElement | null, x: number, y: number) {
  if (!element) return false;
  const bounds = element.getBoundingClientRect();
  return (
    bounds.width > 0 &&
    bounds.height > 0 &&
    x >= bounds.left &&
    x <= bounds.right &&
    y >= bounds.top &&
    y <= bounds.bottom
  );
}

function isPreviewEdge(preview: HTMLDivElement | null, x: number, y: number) {
  const bounds = preview?.getBoundingClientRect();
  return Boolean(
    bounds &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    x >= bounds.right - FILES_DRAWER_EDGE_WIDTH &&
    x <= bounds.right &&
    y >= bounds.top &&
    y <= bounds.bottom,
  );
}

/** Observes the preview's outer edge, including native scrollbars, without hit-test layers. */
export function useFilesDrawerEdge(input: {
  readonly enabled: boolean;
  readonly controller: FilesDrawerController;
  readonly previewRef: RefObject<HTMLDivElement | null>;
  readonly drawerRef: RefObject<HTMLDivElement | null>;
  readonly handleRef: RefObject<HTMLButtonElement | null>;
}) {
  const { enabled, controller, previewRef, drawerRef, handleRef } = input;
  useEffect(() => {
    if (!enabled) return;
    function observePointer(event: PointerEvent) {
      if (event.pointerType === "touch") return;
      const target = event.target instanceof Node ? event.target : null;
      controller.observeTriggers(
        isPreviewEdge(previewRef.current, event.clientX, event.clientY),
        Boolean(target && handleRef.current?.contains(target)),
      );
      const drawer = drawerRef.current;
      if (
        drawer &&
        !drawer.inert &&
        ((target && drawer.contains(target)) || containsPoint(drawer, event.clientX, event.clientY))
      ) {
        controller.setActivity("pointer", true);
        return;
      }
      controller.setActivity("pointer", false);
    }
    function leaveWindow(event: PointerEvent) {
      if (event.relatedTarget !== null) return;
      // Native scrollbar chrome can report a null relatedTarget without leaving
      // the viewport. Keep that inclusive edge eligible; genuine exits cancel it.
      if (
        event.clientX >= 0 &&
        event.clientX < window.innerWidth &&
        event.clientY >= 0 &&
        event.clientY < window.innerHeight &&
        isPreviewEdge(previewRef.current, event.clientX, event.clientY)
      ) {
        controller.observeTriggers(true, false);
      } else {
        controller.observeTriggers(false, false);
        controller.setActivity("pointer", false);
      }
    }
    function loseWindowFocus() {
      controller.observeTriggers(false, false);
      controller.setActivity("pointer", false);
    }
    const options = { capture: true, passive: true };
    window.addEventListener("pointermove", observePointer, options);
    window.addEventListener("pointerover", observePointer, options);
    window.addEventListener("pointerout", leaveWindow, { passive: true });
    window.addEventListener("blur", loseWindowFocus);
    return () => {
      window.removeEventListener("pointermove", observePointer, options);
      window.removeEventListener("pointerover", observePointer, options);
      window.removeEventListener("pointerout", leaveWindow);
      window.removeEventListener("blur", loseWindowFocus);
    };
  }, [controller, drawerRef, enabled, handleRef, previewRef]);
}
