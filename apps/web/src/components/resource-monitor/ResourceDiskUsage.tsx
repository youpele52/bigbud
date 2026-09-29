import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { ChartTooltipContent } from "../ui/chart";
import { formatBytes, formatPercent } from "./resourceMonitor.format";

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

export function ResourceDiskUsage({ usage, detail }: { usage: DiskUsage; detail?: string }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const usedBytes = usage.totalBytes - usage.freeBytes;
  const free = formatBytes(usage.freeBytes);
  const total = formatBytes(usage.totalBytes);
  const used = formatBytes(usedBytes);
  const usedPercent = formatPercent((usedBytes / usage.totalBytes) * 100);
  const description = `Storage usage: ${usedPercent} used, ${used} used, ${free} free, ${total} total`;
  const slices = [
    { name: "Used", value: usedBytes, fill: "var(--chart-1)" },
    { name: "Free", value: usage.freeBytes, fill: "var(--chart-2)" },
  ];

  const activeSlice = activeIndex === null ? undefined : slices[activeIndex];

  return (
    <div className="w-full space-y-2">
      <div className="grid w-full grid-cols-[2fr_1fr] items-center gap-2">
        <div className="relative aspect-square min-w-0" role="figure" aria-label={description}>
          <div className="absolute inset-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart accessibilityLayer>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="56%"
                  outerRadius="78%"
                  stroke="var(--card)"
                  strokeWidth={2}
                  isAnimationActive={false}
                  onMouseEnter={(_, index) => setActiveIndex(index)}
                  onMouseLeave={() => setActiveIndex(null)}
                >
                  {slices.map((slice) => (
                    <Cell
                      key={slice.name}
                      fill={slice.fill}
                      aria-label={`Show ${slice.name.toLowerCase()} storage`}
                    />
                  ))}
                </Pie>
                <Tooltip
                  content={
                    <ChartTooltipContent
                      valueFormatter={(value) =>
                        formatBytes(typeof value === "number" ? value : Number(value))
                      }
                    />
                  }
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs"
          >
            <span className="font-semibold tabular-nums">
              {activeSlice
                ? formatPercent((activeSlice.value / usage.totalBytes) * 100)
                : usedPercent}
            </span>
          </div>
        </div>
        <div
          role="group"
          aria-label="Storage breakdown"
          className="min-w-0 space-y-2 text-xs tabular-nums"
        >
          {slices.map((slice) => (
            <div key={slice.name} className="min-w-0">
              <p className="flex items-center gap-1 text-muted-foreground">
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: slice.fill }}
                />
                {slice.name}
              </p>
              <p className="ps-3 font-medium">{formatBytes(slice.value)}</p>
            </div>
          ))}
        </div>
      </div>
      {detail ? <p className="text-xs leading-snug text-muted-foreground">{detail}</p> : null}
    </div>
  );
}
