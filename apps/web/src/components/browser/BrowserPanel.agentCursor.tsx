import { MousePointer2Icon } from "lucide-react";

interface BrowserAgentCursorProps {
  cursor: { readonly x: number; readonly y: number } | undefined;
}

export function BrowserAgentCursor({ cursor }: BrowserAgentCursorProps) {
  return (
    <div
      className="pointer-events-none absolute z-10 motion-safe:transition-[left,top] motion-safe:duration-200"
      style={
        cursor
          ? { left: cursor.x, top: cursor.y, transform: "translate(-2px, -2px)" }
          : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
      }
      aria-label="Agent cursor"
      role="img"
    >
      <MousePointer2Icon className="size-8 fill-info text-info drop-shadow-md" />
    </div>
  );
}
