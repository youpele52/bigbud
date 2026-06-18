import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

import type {
  BrowserAnnotationIntent,
  BrowserAnnotationSelection,
  BrowserAnnotationTheme,
} from "./BrowserPanel.annotation";

interface PdfAnnotationOverlayProps {
  theme: BrowserAnnotationTheme;
  onResolve: (selection: BrowserAnnotationSelection) => void;
}

interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EMPTY_RECT: SelectionRect = { x: 0, y: 0, width: 0, height: 0 };

function mix(color: string, amount: number): string {
  return `color-mix(in srgb, ${color} ${amount}%, transparent)`;
}

function annotationLabel(intent: BrowserAnnotationIntent): string {
  if (intent === "fix") return "Add task";
  if (intent === "context") return "Add as context";
  return "Add to chat";
}

function buildRegionSelection(
  rect: SelectionRect,
  comment: string,
  intent: BrowserAnnotationIntent,
  viewport: { width: number; height: number },
): BrowserAnnotationSelection {
  return {
    cancelled: false,
    comment: comment.trim(),
    intent,
    element: {
      selector: "",
      tag: "pdf-region",
      role: "region",
      text: "PDF region annotation",
      ariaLabel: null,
      id: null,
      className: "",
      rect,
    },
    viewport: {
      width: viewport.width,
      height: viewport.height,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
  };
}

export function BrowserPdfAnnotationOverlay({ theme, onResolve }: PdfAnnotationOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [intent, setIntent] = useState<BrowserAnnotationIntent>("ask");
  const [comment, setComment] = useState("");
  const [dragging, setDragging] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<SelectionRect>(EMPTY_RECT);

  const hasSelection = rect.width >= 6 && rect.height >= 6;

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const readLocalPoint = (clientX: number, clientY: number) => {
    const bounds = rootRef.current?.getBoundingClientRect();
    return {
      x: clientX - (bounds?.left ?? 0),
      y: clientY - (bounds?.top ?? 0),
    };
  };

  const readViewport = () => {
    const bounds = rootRef.current?.getBoundingClientRect();
    return {
      width: Math.round(bounds?.width ?? window.innerWidth),
      height: Math.round(bounds?.height ?? window.innerHeight),
    };
  };

  const updateRect = (clientX: number, clientY: number) => {
    if (!startPoint) return;
    const point = readLocalPoint(clientX, clientY);
    const left = Math.min(startPoint.x, point.x);
    const top = Math.min(startPoint.y, point.y);
    setRect({
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(Math.abs(point.x - startPoint.x)),
      height: Math.round(Math.abs(point.y - startPoint.y)),
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    setDragging(true);
    const nextPoint = readLocalPoint(event.clientX, event.clientY);
    setStartPoint(nextPoint);
    setRect({ x: nextPoint.x, y: nextPoint.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    setDragging(true);
    const nextPoint = readLocalPoint(event.clientX, event.clientY);
    setStartPoint(nextPoint);
    setRect({ x: nextPoint.x, y: nextPoint.y, width: 0, height: 0 });
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    updateRect(event.clientX, event.clientY);
    event.preventDefault();
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!dragging) return;
    updateRect(event.clientX, event.clientY);
    event.preventDefault();
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    updateRect(event.clientX, event.clientY);
    event.currentTarget.releasePointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    updateRect(event.clientX, event.clientY);
    event.preventDefault();
  };

  const modeButtonStyle = (mode: BrowserAnnotationIntent) => ({
    background: intent === mode ? mix(theme.foreground, 8) : "transparent",
    color: intent === mode ? theme.foreground : theme.mutedForeground,
    fontWeight: intent === mode ? 600 : 500,
  });

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-[2147483647] cursor-crosshair"
      style={{ background: mix(theme.infoForeground, 5) }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onResolve({ cancelled: true });
        }
      }}
      tabIndex={-1}
      data-testid="browser-pdf-annotation-overlay"
    >
      {(dragging || hasSelection) && (
        <div
          className="pointer-events-none absolute border-2"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            borderColor: theme.infoForeground,
            background: mix(theme.infoForeground, 16),
            boxShadow: `0 0 0 1px ${mix(theme.infoForeground, 32)}`,
          }}
        />
      )}

      {hasSelection && !dragging && (
        <div
          className="absolute bottom-4 right-4 w-[min(420px,calc(100%-32px))] cursor-default rounded-[20px] border p-3.5 shadow-[0_18px_54px_rgba(0,0,0,0.24)]"
          style={{
            background: theme.card,
            borderColor: theme.border,
            color: theme.foreground,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <p className="mb-2 text-sm font-medium text-foreground">Annotate PDF region</p>
          <p className="mb-2.5 text-xs leading-snug text-muted-foreground">
            Selected region: x={rect.x} y={rect.y} width={rect.width} height={rect.height}
          </p>
          <div className="mb-2.5 flex gap-0.5">
            {(["ask", "context", "fix"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className="h-7 w-16 rounded-md border-0 px-0 text-xs capitalize"
                style={modeButtonStyle(mode)}
                onClick={() => setIntent(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
          <textarea
            className="min-h-[120px] w-full resize-y rounded-2xl border p-3 text-sm outline-none"
            style={{
              background: theme.card,
              borderColor: theme.border,
              color: theme.foreground,
            }}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            autoFocus
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-[10px] border px-3 py-1.5 text-sm"
              style={{
                background: mix(theme.foreground, 4),
                borderColor: theme.border,
                color: theme.foreground,
              }}
              onClick={() => onResolve({ cancelled: true })}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-[10px] border px-3 py-1.5 text-sm"
              style={{
                background: theme.primary,
                borderColor: theme.primary,
                color: theme.primaryForeground,
              }}
              onClick={() => onResolve(buildRegionSelection(rect, comment, intent, readViewport()))}
            >
              {annotationLabel(intent)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
