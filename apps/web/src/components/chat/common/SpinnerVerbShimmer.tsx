interface SpinnerVerbShimmerProps {
  verb: string;
  trailingEllipsis?: boolean;
  workingColor?: boolean;
}

export function SpinnerVerbShimmer({
  verb,
  trailingEllipsis = false,
  workingColor = false,
}: SpinnerVerbShimmerProps) {
  return (
    <span
      className={
        workingColor
          ? "shimmer text-info-foreground shimmer-color-info-foreground/60 leading-none"
          : "shimmer leading-none"
      }
    >
      {verb}
      {trailingEllipsis ? "..." : null}
    </span>
  );
}
