import { Pie, PieChart } from "recharts";

import { formatBytes, formatPercent } from "./resourceMonitor.format";

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

export function ResourceDiskUsage({ usage }: { usage: DiskUsage }) {
  const usedBytes = usage.totalBytes - usage.freeBytes;
  const free = formatBytes(usage.freeBytes);
  const total = formatBytes(usage.totalBytes);
  const used = formatBytes(usedBytes);
  const description = `${free} free of ${total}; ${used} used`;
  const slices = [
    { name: "Used", value: usedBytes, fill: "var(--chart-1)" },
    { name: "Free", value: usage.freeBytes, fill: "var(--chart-2)" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative size-24 shrink-0" role="img" aria-label={description}>
        <div aria-hidden="true">
          <PieChart width={96} height={96} accessibilityLayer={false}>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={33}
              outerRadius={45}
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={false}
            />
          </PieChart>
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-xs"
        >
          <span className="font-semibold tabular-nums">
            {formatPercent((usedBytes / usage.totalBytes) * 100)}
          </span>
          <span className="text-muted-foreground">used</span>
        </div>
      </div>
      <div className="min-w-0 flex-1 basis-28 space-y-1 text-sm tabular-nums">
        <p className="font-semibold">
          {free} free <span className="font-normal text-muted-foreground">of {total}</span>
        </p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-(--chart-1)" />
          {used} used
        </p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-(--chart-2)" />
          {free} free
        </p>
      </div>
    </div>
  );
}
