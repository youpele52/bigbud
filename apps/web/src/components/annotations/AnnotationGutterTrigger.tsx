import { MousePointer2Icon } from "lucide-react";
import type { MouseEventHandler, ReactNode } from "react";

import { cn } from "../../lib/utils";

interface AnnotationGutterTriggerProps {
  readonly ariaLabel: string;
  readonly fallback?: ReactNode;
  readonly showIcon?: boolean;
  readonly showIconOnFocus?: boolean;
  readonly active?: boolean;
  readonly className?: string;
  readonly onClick: MouseEventHandler<HTMLButtonElement>;
}

export function AnnotationGutterTrigger({
  ariaLabel,
  fallback,
  showIcon = true,
  showIconOnFocus = true,
  active = false,
  className,
  onClick,
}: AnnotationGutterTriggerProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-annotation-gutter-trigger="true"
      className={cn(
        "group relative flex h-5 cursor-pointer items-center justify-center overflow-visible text-muted-foreground/70 outline-none hover:bg-accent/40 hover:text-foreground focus-visible:bg-accent/40 focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
        active && "fill-info text-info hover:text-info focus-visible:text-info",
        className,
      )}
      onClick={onClick}
      title={ariaLabel}
    >
      {showIcon || active || showIconOnFocus ? (
        <MousePointer2Icon
          aria-hidden="true"
          className={cn(
            "pointer-events-none size-8",
            showIcon || active ? "block" : "hidden group-focus-visible:block",
          )}
        />
      ) : null}
      {fallback === undefined ? null : (
        <span
          className={cn(
            "absolute right-2",
            showIcon || active ? "hidden" : showIconOnFocus && "group-focus-visible:hidden",
          )}
        >
          {fallback}
        </span>
      )}
    </button>
  );
}
