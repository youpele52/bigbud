"use client";

import { cn } from "~/lib/utils";
import { Tooltip as RechartsTooltip } from "recharts";

type ChartConfig = Record<
  string,
  {
    readonly color: string;
    readonly label: string;
  }
>;

function ChartContainer({
  children,
  className,
  config,
}: React.ComponentProps<"div"> & {
  readonly config: ChartConfig;
}) {
  return (
    <div
      className={cn("w-full", className)}
      style={
        Object.fromEntries(
          Object.entries(config).map(([key, value]) => [`--color-${key}`, value.color]),
        ) as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}

const ChartTooltip = RechartsTooltip;

function ChartTooltipContent({
  active,
  label,
  payload,
}: {
  readonly active?: boolean;
  readonly label?: string;
  readonly payload?: ReadonlyArray<{
    readonly color?: string;
    readonly dataKey?: string | number;
    readonly name?: string;
    readonly value?: number | string;
  }>;
}) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  return (
    <div className="min-w-40 rounded-md border border-border/70 bg-popover px-3 py-2 shadow-sm">
      {label ? <div className="mb-2 text-xs font-medium text-foreground">{label}</div> : null}
      <div className="space-y-1.5">
        {payload.map((item) => (
          <div
            key={String(item.dataKey ?? item.name)}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: item.color ?? "currentColor" }}
              />
              <span>{item.name ?? item.dataKey}</span>
            </div>
            <span className="font-medium text-foreground">
              {typeof item.value === "number" ? item.value.toLocaleString() : item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig };
