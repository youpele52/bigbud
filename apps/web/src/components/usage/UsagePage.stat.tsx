import type { ComponentType } from "react";
import { cn } from "~/lib/utils";

import { Card, CardContent } from "../ui/card";

export function UsageStatCard({
  icon: Icon,
  label,
  value,
  compact = false,
  sourceLabel,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly value: string;
  readonly compact?: boolean;
  readonly sourceLabel?: string;
}) {
  return (
    <Card className="min-w-0">
      <CardContent
        className={cn("flex items-center gap-3 p-4", compact && "flex-col items-start gap-2 p-3")}
      >
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/50",
            compact && "size-6",
          )}
        >
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 max-w-full">
          <h3 className={cn("text-muted-foreground", compact && "text-xs")}>{label}</h3>
          <div className="truncate text-sm font-medium text-foreground" title={value}>
            {value}
          </div>
          {sourceLabel ? (
            <span className="text-xs text-muted-foreground">{sourceLabel}</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
