import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { formatCompactNumber } from "./UsagePage.format";

export type UsageDonutSlice = {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly fill: string;
};

const DONUT_CONFIG = {} as const;
// `sm` fits a side pane; `lg` is the standalone share view.
const DONUT_SIZES = {
  sm: { className: "h-48 min-h-48", innerRadius: 52, outerRadius: 72 },
  lg: { className: "h-64 min-h-64", innerRadius: 68, outerRadius: 96 },
} as const;

/** The usage page's donut: thin ring, surface-colored gaps, total in the middle. */
export function UsageDonut({
  slices,
  total,
  size = "sm",
}: {
  readonly slices: ReadonlyArray<UsageDonutSlice>;
  readonly total: number;
  readonly size?: keyof typeof DONUT_SIZES;
}) {
  const dimensions = DONUT_SIZES[size];
  return (
    <div className="relative">
      <ChartContainer className={dimensions.className} config={DONUT_CONFIG}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie
              cx="50%"
              cy="50%"
              data={slices.map((slice) => ({ ...slice }))}
              dataKey="value"
              innerRadius={dimensions.innerRadius}
              nameKey="label"
              outerRadius={dimensions.outerRadius}
              paddingAngle={2}
              stroke="var(--background)"
              strokeWidth={3}
            >
              {slices.map((slice) => (
                <Cell key={slice.id} fill={slice.fill} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </ChartContainer>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="text-center">
          <div className="text-xs text-muted-foreground">Total</div>
          <div className="text-sm font-medium text-foreground">{formatCompactNumber(total)}</div>
        </div>
      </div>
    </div>
  );
}

/** Legend that doubles as the value table: swatch, label, full count. */
export function UsageLegendList({ slices }: { readonly slices: ReadonlyArray<UsageDonutSlice> }) {
  return (
    <div className="space-y-2">
      {slices.map((slice) => (
        <div key={slice.id} className="flex items-center justify-between gap-3 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: slice.fill }}
            />
            <span className="truncate text-foreground" title={slice.label}>
              {slice.label}
            </span>
          </div>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {slice.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
