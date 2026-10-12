import { useId } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import type { HistoryPoint } from "~/stores/resource-monitor/resourceMonitor.store";
import { CenteredStatus } from "../common/CenteredStatus";

/** A separately scaled usage trend, with units preserved in its hover values. */
export function ResourceUsageTrend({
  label,
  value,
  history,
  color,
  formatValue,
  large = false,
  loading = value !== "—",
}: {
  label: "CPU" | "Memory";
  value: string;
  history: HistoryPoint[];
  color: string;
  formatValue: (value: number) => string;
  large?: boolean;
  loading?: boolean;
}) {
  const gradientId = useId();
  const available = value !== "—";
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-background/60">
      <div className="space-y-1 px-3 pt-3">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
          {label}
        </p>
        <p className="text-sm font-semibold tracking-tight tabular-nums">{value}</p>
      </div>
      <div className={large ? "h-28" : "h-20"}>
        {available && history.length > 1 ? (
          <div className="h-full" role="img" aria-label={`Including agents/tools ${label} history`}>
            <ChartContainer config={{ value: { label, color } }} className="h-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  accessibilityLayer
                  data={history}
                  margin={{ top: 12, right: 0, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
                  <XAxis dataKey="sequence" hide />
                  <YAxis domain={[0, "auto"]} hide />
                  <ChartTooltip
                    cursor={{ stroke: "var(--color-value)", strokeDasharray: "3 3" }}
                    content={
                      <ChartTooltipContent
                        labelFormatter={() => ""}
                        valueFormatter={(raw) => formatValue(Number(raw))}
                      />
                    }
                  />
                  <Area
                    dataKey="value"
                    name={label}
                    type="monotone"
                    baseValue={0}
                    stroke="var(--color-value)"
                    strokeWidth={2}
                    fill={`url(#${gradientId})`}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartContainer>
          </div>
        ) : (
          <CenteredStatus loading={loading} className="h-full px-2">
            {loading ? "Waiting for history" : "Measurements unavailable"}
          </CenteredStatus>
        )}
      </div>
    </div>
  );
}
