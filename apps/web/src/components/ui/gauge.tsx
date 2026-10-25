"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
  DEFAULT_GAUGE_BANDS,
  gaugeColor,
  gaugeReading,
  gaugeSegments,
  type GaugeBand,
} from "./gauge.logic";

export type GaugeProps = Omit<ComponentProps<"div">, "children"> & {
  value?: number | null | undefined;
  min?: number;
  max?: number;
  label: string;
  description?: ReactNode;
  formatValue?: (value: number) => string;
  /** Override the readout without changing the bounded needle (e.g. an over-capacity estimate). */
  valueText?: string;
  segments?: number;
  bands?: readonly GaugeBand[];
};

function defaultFormat(value: number) {
  return value.toLocaleString();
}

/** A reusable segmented semicircle meter with a needle, readable value, and optional caption. */
export function Gauge({
  value,
  min = 0,
  max = 100,
  label,
  description,
  formatValue = defaultFormat,
  valueText,
  segments = 40,
  bands = DEFAULT_GAUGE_BANDS,
  className,
  ...props
}: GaugeProps) {
  const reading = gaugeReading(value, min, max);
  const formatted = reading ? (valueText ?? formatValue(reading.value)) : "—";
  const color = reading ? gaugeColor(reading.fraction, bands) : "var(--muted-foreground)";
  return (
    <div
      {...props}
      data-slot="gauge"
      data-state={reading ? "ready" : "unavailable"}
      role={reading ? "meter" : "img"}
      aria-label={
        reading || label.toLowerCase().includes("unavailable") ? label : `${label} unavailable`
      }
      aria-valuemin={reading ? min : undefined}
      aria-valuemax={reading ? max : undefined}
      aria-valuenow={reading?.value}
      aria-valuetext={reading ? (props["aria-valuetext"] ?? formatted) : undefined}
      className={cn("mx-auto w-full max-w-56 space-y-1 text-center text-sm", className)}
    >
      <svg
        data-slot="gauge-arc"
        viewBox="0 0 240 128"
        className="block w-full overflow-visible"
        aria-hidden="true"
      >
        {gaugeSegments(segments).map((segment) => (
          <line
            key={segment.index}
            data-slot="gauge-segment"
            data-active={
              reading && reading.fraction > 0 && segment.fraction <= reading.fraction
                ? "true"
                : "false"
            }
            x1={segment.x1}
            y1={segment.y1}
            x2={segment.x2}
            y2={segment.y2}
            stroke={reading ? gaugeColor(segment.fraction, bands) : "var(--muted-foreground)"}
            strokeWidth={3.5}
            strokeLinecap="round"
            className="opacity-20 transition-opacity duration-300 data-[active=true]:opacity-100 motion-reduce:transition-none"
          />
        ))}
        {reading ? (
          <g
            data-slot="gauge-needle"
            style={{ transform: `rotate(${reading.angle}deg)`, transformOrigin: "120px 108px" }}
            className="transition-transform duration-500 ease-out motion-reduce:transition-none"
          >
            <path d="M 46 108 L 120 105 L 120 111 Z" fill="var(--foreground)" fillOpacity={0.8} />
          </g>
        ) : null}
        <circle
          cx={120}
          cy={108}
          r={5}
          fill="var(--background)"
          stroke={reading ? "var(--foreground)" : "var(--muted-foreground)"}
          strokeWidth={2}
        />
        <text x={26} y={126} textAnchor="middle" fill="var(--muted-foreground)" className="text-xs">
          {formatValue(min)}
        </text>
        <text
          x={214}
          y={126}
          textAnchor="middle"
          fill="var(--muted-foreground)"
          className="text-xs"
        >
          {formatValue(max)}
        </text>
      </svg>
      <div
        data-slot="gauge-value"
        aria-hidden="true"
        className="text-2xl font-semibold tracking-tight tabular-nums"
        style={{ color }}
      >
        {formatted}
      </div>
      {description ? (
        <div data-slot="gauge-description" className="text-xs text-muted-foreground">
          {description}
        </div>
      ) : null}
    </div>
  );
}

export type { GaugeBand } from "./gauge.logic";
