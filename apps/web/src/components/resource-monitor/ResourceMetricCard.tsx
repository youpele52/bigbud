import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

export interface DisplayPoint {
  sequence: number;
  value: number;
}

export interface DisplayMetric {
  label: string;
  value: string;
  status: string;
  detail?: string;
  history?: readonly DisplayPoint[];
}

export function ResourceMetricCard({
  metric,
  large = false,
}: {
  metric: DisplayMetric;
  large?: boolean;
}) {
  const hasHistory = (metric.history?.length ?? 0) > 1;
  return (
    <Card className="min-w-0 gap-2 py-3">
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium">{metric.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        <div className="truncate text-xl font-semibold tabular-nums" title={metric.value}>
          {metric.value}
        </div>
        {metric.detail ? (
          <p className="truncate text-xs text-muted-foreground" title={metric.detail}>
            {metric.detail}
          </p>
        ) : null}
        {metric.status !== "ready" ? (
          <p className="text-xs capitalize text-muted-foreground">
            {metric.status.replaceAll("_", " ")}
          </p>
        ) : null}
        {hasHistory ? (
          <div
            className={large ? "h-28" : "h-12"}
            role="img"
            aria-label={`${metric.label} history`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={metric.history as DisplayPoint[]}>
                <XAxis dataKey="sequence" hide />
                {large ? <Tooltip formatter={(value) => `${value}`} /> : null}
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="var(--chart-1)"
                  fill="var(--chart-1)"
                  fillOpacity={0.12}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
