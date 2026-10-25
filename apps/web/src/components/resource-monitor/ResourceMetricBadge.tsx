import type { ComponentProps } from "react";
import { Badge } from "../ui/badge";
import { cn } from "~/lib/utils";

/** A consistent compact badge for memory totals, logical cores, and process counts. */
export function ResourceMetricBadge({ className, ...props }: ComponentProps<typeof Badge>) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-auto rounded-full border-border/60 bg-background/60 px-2 py-0.5 text-xs font-normal tabular-nums text-muted-foreground sm:h-auto sm:text-xs",
        className,
      )}
      {...props}
    />
  );
}
