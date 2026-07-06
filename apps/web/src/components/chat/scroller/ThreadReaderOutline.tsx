import { type MessageId } from "@bigbud/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

const BASE_SEGMENT_WIDTH_PX = 8;
const NEIGHBOR_SEGMENT_WIDTH_PX = 16;
const CURRENT_SEGMENT_WIDTH_PX = 22;
const HOVERED_SEGMENT_WIDTH_PX = 32;
const SEGMENT_BUTTON_HEIGHT_PX = 10;
const SEGMENT_GAP_PX = 1;
const OUTLINE_VERTICAL_PADDING_PX = 8;

interface ThreadReaderOutlineProps {
  anchors: ReadonlyArray<{ messageId: MessageId; label: string }>;
  currentAnchorMessageId: MessageId | null;
  onJumpToMessage: (messageId: MessageId) => void;
  className?: string | undefined;
}

export function ThreadReaderOutline({
  anchors,
  currentAnchorMessageId,
  onJumpToMessage,
  className,
}: ThreadReaderOutlineProps) {
  const [hoveredAnchorIndex, setHoveredAnchorIndex] = useState<number | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [rootHeightPx, setRootHeightPx] = useState<number>(0);

  useEffect(
    () => () => {
      if (clickTimeoutRef.current !== null) {
        clearTimeout(clickTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!outlineOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node) ?? false) {
        return;
      }
      setOutlineOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [outlineOpen]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = root.getBoundingClientRect().height;
      setRootHeightPx((currentHeight) => {
        if (Math.abs(currentHeight - nextHeight) < 0.5) {
          return currentHeight;
        }
        return nextHeight;
      });
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      updateHeight();
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, []);

  if (anchors.length < 2) {
    return null;
  }

  const naturalStackHeightPx =
    anchors.length * SEGMENT_BUTTON_HEIGHT_PX + (anchors.length - 1) * SEGMENT_GAP_PX;
  const availableTrackHeightPx = Math.max(0, rootHeightPx - OUTLINE_VERTICAL_PADDING_PX);
  const shouldCompress =
    availableTrackHeightPx > 0 && naturalStackHeightPx > availableTrackHeightPx;

  return (
    <div
      ref={rootRef}
      aria-label="Transcript outline"
      className={cn(
        "pointer-events-auto h-full w-full overflow-hidden rounded-md px-1 py-1 transition-colors hover:bg-accent/20",
        shouldCompress ? "relative" : "relative flex flex-col items-end justify-center gap-px",
        className,
      )}
      onPointerMove={(event) => {
        if (outlineOpen) {
          return;
        }

        let nearestIndex: number | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;

        for (const [index, button] of buttonRefs.current.entries()) {
          if (!button) {
            continue;
          }
          const rect = button.getBoundingClientRect();
          const centerY = rect.top + rect.height / 2;
          const distance = Math.abs(event.clientY - centerY);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestIndex = index;
          }
        }

        if (nearestIndex !== null && nearestIndex !== hoveredAnchorIndex) {
          setHoveredAnchorIndex(nearestIndex);
        }
      }}
      onMouseLeave={() => {
        setHoveredAnchorIndex(null);
        if (!outlineOpen) {
          return;
        }
      }}
    >
      {outlineOpen ? (
        <div className="absolute right-full top-1/2 mr-3 flex max-h-[50dvh] w-56 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border/70 bg-background/96 shadow-lg shadow-black/10 backdrop-blur-sm dark:border-border/60 dark:bg-background/92">
          <div className="overflow-y-auto overscroll-y-contain px-1 py-2">
            {anchors.map((anchor) => {
              const isCurrent = currentAnchorMessageId === anchor.messageId;

              return (
                <button
                  key={anchor.messageId}
                  type="button"
                  aria-current={isCurrent ? "location" : undefined}
                  className={cn(
                    "flex min-h-7 w-full cursor-pointer items-center rounded-lg px-2 text-left text-sm outline-none transition-colors",
                    isCurrent
                      ? "bg-accent/85 font-medium text-foreground hover:bg-accent dark:bg-accent/55 dark:hover:bg-accent/70"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  onClick={() => {
                    setOutlineOpen(false);
                    onJumpToMessage(anchor.messageId);
                  }}
                >
                  <span className="line-clamp-2 min-w-0">{anchor.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {anchors.map((anchor, index) => {
        const isCurrent = anchor.messageId === currentAnchorMessageId;
        const isHovered = hoveredAnchorIndex === index;
        const hoverDistance =
          hoveredAnchorIndex === null ? null : Math.abs(hoveredAnchorIndex - index);
        const widthPx =
          hoverDistance === 0
            ? HOVERED_SEGMENT_WIDTH_PX
            : hoverDistance === 1
              ? NEIGHBOR_SEGMENT_WIDTH_PX
              : isCurrent
                ? CURRENT_SEGMENT_WIDTH_PX
                : BASE_SEGMENT_WIDTH_PX;

        const compressedTopPx =
          anchors.length <= 1 || availableTrackHeightPx <= 0
            ? OUTLINE_VERTICAL_PADDING_PX / 2 + SEGMENT_BUTTON_HEIGHT_PX / 2
            : OUTLINE_VERTICAL_PADDING_PX / 2 +
              (index / (anchors.length - 1)) * availableTrackHeightPx;

        return (
          <button
            key={anchor.messageId}
            type="button"
            aria-label={anchor.label}
            aria-current={isCurrent ? "location" : undefined}
            className={cn(
              "relative flex h-2.5 w-full items-center justify-end outline-none",
              shouldCompress ? "absolute left-0" : "",
            )}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            style={
              shouldCompress
                ? {
                    top: `${compressedTopPx}px`,
                    transform: "translateY(-50%)",
                  }
                : undefined
            }
            onClick={() => {
              if (clickTimeoutRef.current !== null) {
                clearTimeout(clickTimeoutRef.current);
              }
              clickTimeoutRef.current = setTimeout(() => {
                setOutlineOpen(false);
                onJumpToMessage(anchor.messageId);
                clickTimeoutRef.current = null;
              }, 180);
            }}
            onDoubleClick={() => {
              if (clickTimeoutRef.current !== null) {
                clearTimeout(clickTimeoutRef.current);
                clickTimeoutRef.current = null;
              }
              setOutlineOpen(true);
              setHoveredAnchorIndex(index);
            }}
            onFocus={() => setHoveredAnchorIndex(index)}
          >
            {isHovered && !outlineOpen ? (
              <span className="pointer-events-none absolute right-full top-1/2 mr-3 w-56 -translate-y-1/2 rounded-xl border border-border/70 bg-background/96 px-3 py-2 text-left text-sm text-foreground shadow-lg shadow-black/10 backdrop-blur-sm dark:border-border/60 dark:bg-background/92">
                <span className="line-clamp-3 block">{anchor.label}</span>
              </span>
            ) : null}
            <span
              data-current={isCurrent}
              className={cn(
                "block h-0.5 rounded-full bg-muted-foreground/20 transition-[width,background-color] duration-150 ease-out dark:bg-muted-foreground/22",
                hoverDistance === 0 && "bg-muted-foreground/48 dark:bg-muted-foreground/70",
                hoverDistance === 1 && "bg-muted-foreground/34 dark:bg-muted-foreground/48",
                isCurrent && "bg-foreground/85 dark:bg-foreground/88",
              )}
              style={{ width: `${widthPx}px` }}
            />
          </button>
        );
      })}
    </div>
  );
}
