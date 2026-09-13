import type { ReactNode } from "react";

interface SpinnerVerbShimmerProps {
  verb: string;
  trailingEllipsis?: boolean;
  workingColor?: boolean;
  warningColor?: boolean;
  leading?: ReactNode;
}

export function SpinnerVerbShimmer({
  verb,
  trailingEllipsis = false,
  workingColor = false,
  warningColor = false,
  leading,
}: SpinnerVerbShimmerProps) {
  return (
    <span
      className={
        warningColor
          ? "shimmer text-warning shimmer-color-warning/60 leading-none"
          : workingColor
            ? "shimmer text-info-foreground shimmer-color-info-foreground/60 leading-none"
            : "shimmer leading-none"
      }
    >
      {leading}
      {verb}
      {trailingEllipsis ? "..." : null}
    </span>
  );
}
