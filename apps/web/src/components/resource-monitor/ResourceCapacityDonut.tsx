import { Pie, PieChart, ResponsiveContainer } from "recharts";

import { ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { capacityDonutData, type CapacityUsage } from "./ResourceCapacityDonut.logic";
import { renderCapacitySector } from "./ResourceCapacitySector";
import { formatPercent } from "./resourceMonitor.format";

export function ResourceCapacityDonut({
  usage,
  kind,
}: {
  usage: CapacityUsage | undefined;
  kind: "cpu" | "memory";
}) {
  const data = capacityDonutData(usage);
  const label = kind === "cpu" ? "CPU" : "Memory";
  const capacity = kind === "cpu" ? "host CPU" : "host RAM";
  const percentage = formatPercent(data?.percentage);
  return (
    <div className="min-w-0 space-y-2">
      <div
        className="relative mx-auto size-40"
        role="img"
        aria-label={`${label} capacity: ${data ? `${percentage} core bigbud of total ${capacity}` : "unavailable"}`}
      >
        {data ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart accessibilityLayer>
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    valueFormatter={(value, name) =>
                      formatPercent(name === "Core bigbud" ? data.percentage : Number(value))
                    }
                  />
                }
              />
              <Pie
                data={data.slices}
                dataKey="value"
                nameKey="name"
                innerRadius={46}
                outerRadius={62}
                startAngle={90}
                endAngle={-270}
                stroke="var(--card)"
                strokeWidth={2}
                shape={renderCapacitySector}
                isAnimationActive={false}
              />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="absolute inset-3 rounded-full border-8 border-dashed border-muted" />
        )}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span className="text-xl font-semibold tabular-nums">{percentage}</span>
        </div>
      </div>
      {!data ? (
        <p className="text-center text-xs text-muted-foreground">Host capacity share unavailable</p>
      ) : null}
      {data?.exceedsCapacity ? (
        <p className="text-xs text-amber-600">
          Estimate exceeds host RAM; shared pages may be counted more than once.
        </p>
      ) : null}
    </div>
  );
}
