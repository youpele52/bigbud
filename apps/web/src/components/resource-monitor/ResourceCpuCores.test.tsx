import type { MonitorNamedMetric } from "@bigbud/contracts/system-monitor/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResourceCpuCore } from "./ResourceCpuCore";
import { ResourceCpuCores } from "./ResourceCpuCores";
import { cpuCoreReadings } from "./ResourceCpuCores.fixtures";
import { usagePercentColor } from "../ui/usageBands.logic";

const reading: MonitorNamedMetric = {
  name: "0",
  metric: { value: 0, status: "ready", sampledAtMs: 1000 },
};

describe("horizontal core usage bars", () => {
  it.each([0, 39.22, 100])("uses a fixed semantic scale and exact value for %s%%", (value) => {
    const markup = renderToStaticMarkup(
      <ResourceCpuCore core={{ ...reading, metric: { ...reading.metric, value } }} active />,
    );
    expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-label="Core 0 usage"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(markup).toContain(`aria-valuenow="${value}"`);
    expect(markup).toContain(`width:${value}%`);
    expect(markup).toContain(`background-color:${usagePercentColor(value)}`);
    expect(markup).not.toContain("bg-info");
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).not.toContain(">Critical usage</span>");
  });
  it.each([
    [0, "var(--chart-1)", "Normal usage"],
    [49.999, "var(--chart-1)", "Normal usage"],
    [50, "var(--chart-3)", "High usage"],
    [79.999, "var(--chart-3)", "High usage"],
    [80, "var(--chart-4)", "Critical usage"],
    [100, "var(--chart-4)", "Critical usage"],
  ] as const)("uses %s%% usage colors and accessible severity", (value, color, status) => {
    const markup = renderToStaticMarkup(
      <ResourceCpuCore core={{ ...reading, metric: { ...reading.metric, value } }} active />,
    );
    expect(markup).toContain(color);
    expect(markup).toContain(`title="${status}"`);
    expect(markup).toContain(`aria-valuetext="${value.toFixed(2)}% · ${status}"`);
  });
  it.each([-1, 101, NaN, Infinity])(
    "keeps invalid reading %s unknown rather than capping or showing zero",
    (value) => {
      const markup = renderToStaticMarkup(
        <ResourceCpuCore core={{ ...reading, metric: { ...reading.metric, value } }} active />,
      );
      expect(markup).toContain('role="img"');
      expect(markup).toContain("Unavailable");
      expect(markup).not.toContain("aria-valuenow");
      expect(markup).not.toContain("cpu-core-fill");
      expect(markup).not.toContain("0.00%");
    },
  );
  it.each(["warming", "stale", "unsupported", "denied", "unavailable"] as const)(
    "preserves %s states as unknown",
    (status) => {
      const markup = renderToStaticMarkup(
        <ResourceCpuCore core={{ ...reading, metric: { ...reading.metric, status } }} active />,
      );
      expect(markup).toContain(`Core 0 usage ${status}`);
      expect(markup).not.toContain("aria-valuenow");
      expect(markup).not.toContain("cpu-core-fill");
    },
  );
  it("suppresses current values while disconnected and keeps original nonnumeric core labels", () => {
    const markup = renderToStaticMarkup(
      <ResourceCpuCore core={{ ...reading, name: "cpu0" }} active={false} />,
    );
    expect(markup).toContain('aria-label="cpu0 usage unavailable"');
    expect(markup).not.toContain("aria-valuenow");
  });
  it("preserves core order and uses the shared centered empty-state loader", () => {
    const markup = renderToStaticMarkup(
      <ResourceCpuCores cores={cpuCoreReadings()} active loading={false} />,
    );
    expect(markup.match(/aria-label="Core \d+"/g)).toEqual(
      Array.from({ length: 10 }, (_, index) => `aria-label="Core ${index}"`),
    );
    const pending = renderToStaticMarkup(<ResourceCpuCores cores={[]} active={false} loading />);
    expect(pending).toContain("Waiting for core data");
    expect(pending).toContain("text-muted-foreground/40");
    expect(pending).toContain("animate-breathe");
    const unavailable = renderToStaticMarkup(
      <ResourceCpuCores cores={[]} active={false} loading={false} />,
    );
    expect(unavailable).toContain("Core data unavailable");
    expect(unavailable).not.toContain("animate-breathe");
  });
});
