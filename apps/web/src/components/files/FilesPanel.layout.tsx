import { useId, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useFilesTreeDrawer } from "./FilesPanel.drawer";
import { FilesPanelHeader } from "./FilesPanel.header";
import {
  FILES_DRAWER_WIDTH_FACTOR,
  FILES_TREE_MIN_WIDTH,
  FILES_TREE_SEPARATOR_WIDTH,
} from "./FilesPanel.shared";
import { useFilesTreeWidth } from "./FilesPanel.treeWidth";

interface FilesPanelLayoutProps {
  readonly preview: ReactNode;
  readonly treeBody: ReactNode;
  readonly hasPreview: boolean;
  readonly workspaceKey: string;
  readonly contextMenuOpen: boolean;
  readonly visible?: boolean;
}

/** Keeps tree DOM/scroll and preview identity stable across drawer and split modes. */
export function FilesPanelLayout(props: FilesPanelLayoutProps) {
  const drawerId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const drawer = useFilesTreeDrawer({ ...props, visible: props.visible ?? true });
  const { renderedTreeWidth, treeWidthBounds, resizeTreeWidth } = useFilesTreeWidth(containerRef);
  const pinned = drawer.mode === "pinned";
  const visible = !props.hasPreview || drawer.mode !== "closed";
  const split = props.hasPreview && pinned;
  const resizeRef = useRef<{ x: number; pointerId: number } | null>(null);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <FilesPanelHeader
        treeVisible={visible}
        pinned={pinned}
        pinControl={
          props.hasPreview
            ? {
                onClick: drawer.togglePin,
                onFocus: drawer.focus,
                onBlur: drawer.blur,
              }
            : undefined
        }
        treeControl={
          props.hasPreview
            ? {
                ref: drawer.handleRef,
                "aria-controls": drawerId,
                "aria-expanded": visible,
                onPointerEnter: (event) => {
                  if (event.pointerType !== "touch") drawer.enterHandle();
                },
                onPointerLeave: drawer.leaveHandle,
                onFocus: drawer.focus,
                onBlur: drawer.blur,
                onClick: drawer.toggle,
                onKeyDown: (event) => {
                  if (event.key !== "ArrowDown") return;
                  event.preventDefault();
                  drawer.open();
                },
              }
            : undefined
        }
      />
      <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          ref={drawer.previewRef}
          tabIndex={-1}
          className={cn("min-h-0 min-w-0 flex-1 outline-none", !props.hasPreview && "hidden")}
          data-files-preview
        >
          {props.preview}
        </div>
        {split ? (
          <div
            className="z-10 shrink-0 cursor-col-resize touch-none select-none hover:bg-primary/30 focus-visible:bg-primary/30"
            style={{ width: FILES_TREE_SEPARATOR_WIDTH }}
            role="separator"
            aria-label="Resize files tree"
            aria-orientation="vertical"
            aria-valuemin={treeWidthBounds.min}
            aria-valuemax={treeWidthBounds.max}
            aria-valuenow={renderedTreeWidth}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              resizeRef.current = {
                x: event.clientX,
                pointerId: event.pointerId,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const resize = resizeRef.current;
              if (
                !resize ||
                resize.pointerId !== event.pointerId ||
                !containerRef.current ||
                !drawer.drawerRef.current
              )
                return;
              resizeTreeWidth(
                containerRef.current.getBoundingClientRect().width,
                drawer.drawerRef.current.getBoundingClientRect().width,
                event.clientX - resize.x,
              );
              resize.x = event.clientX;
            }}
            onLostPointerCapture={() => {
              resizeRef.current = null;
            }}
            onKeyDown={(event) => {
              if (
                !containerRef.current ||
                !drawer.drawerRef.current ||
                !["ArrowLeft", "ArrowRight"].includes(event.key)
              )
                return;
              event.preventDefault();
              resizeTreeWidth(
                containerRef.current.getBoundingClientRect().width,
                drawer.drawerRef.current.getBoundingClientRect().width,
                event.key === "ArrowLeft" ? -20 : 20,
              );
            }}
          />
        ) : null}
        <div
          id={drawerId}
          ref={drawer.drawerRef}
          role="region"
          aria-label="Files tree"
          aria-hidden={!visible}
          inert={!visible}
          className={cn(
            "flex min-h-0 flex-col bg-background",
            !props.hasPreview && "w-full",
            props.hasPreview && "border-l border-border",
            props.hasPreview && !pinned && "absolute inset-y-0 right-0 z-20 shadow-xl",
            split && "shrink-0",
            !visible && "invisible pointer-events-none",
          )}
          style={
            props.hasPreview
              ? {
                  width: pinned
                    ? renderedTreeWidth
                    : `min(100%, max(${FILES_TREE_MIN_WIDTH}px, ${FILES_DRAWER_WIDTH_FACTOR * 100}%))`,
                }
              : undefined
          }
          onPointerEnter={props.hasPreview ? drawer.enterDrawer : undefined}
          onPointerLeave={props.hasPreview ? drawer.leave : undefined}
          onFocusCapture={props.hasPreview ? drawer.focus : undefined}
          onBlurCapture={props.hasPreview ? drawer.blur : undefined}
          onPointerDownCapture={props.hasPreview ? drawer.startInteraction : undefined}
          onDragStartCapture={props.hasPreview ? drawer.startDrag : undefined}
        >
          <div className="min-h-0 flex-1 overflow-y-auto" data-files-tree-scroll>
            {props.treeBody}
          </div>
        </div>
      </div>
    </div>
  );
}
