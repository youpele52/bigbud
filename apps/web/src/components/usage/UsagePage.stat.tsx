import type { ComponentType } from "react";

import { Card, CardContent } from "../ui/card";

export function UsageStatCard({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/50">
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h3 className="text-muted-foreground">{label}</h3>
          <div className="truncate text-sm font-medium text-foreground">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
