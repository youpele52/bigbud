import type { ComponentType } from "react";

/** Bordered icon tile beside each overview stat. */
export function UsageStatIcon({
  icon: Icon,
}: {
  readonly icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/50">
      <Icon className="size-4 text-muted-foreground" />
    </div>
  );
}
