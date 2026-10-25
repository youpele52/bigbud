import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResourceMemorySwap } from "./ResourceMemorySwap";
import { memorySwapUsage } from "./ResourceMemorySwap.logic";
import { memorySwapMetric, memorySwapSnapshot } from "./ResourceMemorySwap.fixtures";

describe("Memory and swap capacity bars", () => {
  it("reuses Disk bars for both pools and keeps measured Available and Free readings", () => {
    const snapshot = memorySwapSnapshot();
    const markup = renderToStaticMarkup(
      <ResourceMemorySwap snapshot={snapshot} current loading={false} />,
    );
    expect(markup).toContain("Memory and swap");
    expect(markup).toContain('aria-label="RAM capacity used"');
    expect(markup).toContain('aria-label="Swap capacity used"');
    expect(markup).toContain("83.09%");
    expect(markup).toContain("72.75%");
    expect(markup).toContain("53.18 GiB / 64.00 GiB");
    expect(markup).toContain("2.91 GiB / 4.00 GiB");
    expect(markup).toContain("Available: 28.14 GiB");
    expect(markup).toContain("Free: 1.09 GiB");
    expect(markup).not.toContain("10.82 GiB");
    expect(markup).not.toContain('data-slot="gauge"');
    expect(markup).toContain("background-color:var(--chart-4)");
    expect(markup).toContain("background-color:var(--chart-3)");
  });
  it.each(["stale", "denied", "unsupported", "warming"] as const)(
    "does not substitute zeroes for %s measurements",
    (status) => {
      const snapshot = {
        ...memorySwapSnapshot(),
        memoryUsedBytes: memorySwapMetric(0, status),
        swapUsedBytes: memorySwapMetric(0, status),
        memoryAvailableBytes: memorySwapMetric(0, status),
        swapFreeBytes: memorySwapMetric(0, status),
      };
      const usage = memorySwapUsage(snapshot, true);
      expect(usage.ram.usedBytes).toBeNull();
      expect(usage.swap.usedBytes).toBeNull();
      expect(usage.ram.footer).toEqual(["Available: —"]);
      expect(usage.swap.footer).toEqual(["Free: —"]);
      const markup = renderToStaticMarkup(
        <ResourceMemorySwap snapshot={snapshot} current loading={false} />,
      );
      expect(markup).not.toContain('role="meter"');
      expect(markup).not.toContain("0.00%");
      expect(markup).not.toContain("No swap allocated");
      expect(markup.includes('data-loading="true"')).toBe(status === "warming");
    },
  );
  it.each([-1, NaN, Infinity])("rejects invalid memory capacities (%s)", (value) => {
    const snapshot = {
      ...memorySwapSnapshot(),
      memoryUsedBytes: memorySwapMetric(value),
      swapTotalBytes: memorySwapMetric(value),
    };
    const markup = renderToStaticMarkup(
      <ResourceMemorySwap snapshot={snapshot} current loading={false} />,
    );
    expect(markup).not.toContain('role="meter"');
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Infinity");
    expect(markup).not.toContain("-1.00");
  });
  it("preserves genuine zero usage with positive totals", () => {
    const snapshot = {
      ...memorySwapSnapshot(),
      memoryUsedBytes: memorySwapMetric(0),
      swapUsedBytes: memorySwapMetric(0),
    };
    const markup = renderToStaticMarkup(
      <ResourceMemorySwap snapshot={snapshot} current loading={false} />,
    );
    expect(markup.match(/aria-valuenow="0"/g)).toHaveLength(2);
    expect(markup.match(/0.00%/g)).toHaveLength(4);
    expect(markup).not.toContain("No swap allocated");
  });
  it("identifies measured zero-allocation swap without inventing a percentage", () => {
    const snapshot = {
      ...memorySwapSnapshot(),
      swapTotalBytes: memorySwapMetric(0),
      swapUsedBytes: memorySwapMetric(0),
      swapFreeBytes: memorySwapMetric(0),
    };
    const markup = renderToStaticMarkup(
      <ResourceMemorySwap snapshot={snapshot} current loading={false} />,
    );
    expect(markup).toContain("No swap allocated");
    expect(markup).toContain("0.00 GiB / 0.00 GiB");
    expect(markup).toContain("Free: 0.00 GiB");
    expect(markup).not.toContain('aria-label="Swap capacity used"');
    expect(markup).not.toContain('data-loading="true"');
  });
  it("preserves the actual over-capacity RAM estimate and bounds only the bar and meter scale", () => {
    const snapshot = { ...memorySwapSnapshot(), memoryUsedBytes: memorySwapMetric(80) };
    const markup = renderToStaticMarkup(
      <ResourceMemorySwap snapshot={snapshot} current loading={false} />,
    );
    expect(markup).toContain("80.00 GiB / 64.00 GiB");
    expect(markup).toContain("125.00%");
    expect(markup).toContain('aria-valuenow="100"');
    expect(markup).toContain('aria-valuetext="125.00% used · Usage exceeds capacity"');
    expect(markup).toContain('style="width:100%;background-color:var(--chart-4)"');
    expect(markup).not.toContain('style="width:125%');
  });
  it("does not accept inconsistent Swap used values as an estimate", () => {
    const markup = renderToStaticMarkup(
      <ResourceMemorySwap
        snapshot={{ ...memorySwapSnapshot(), swapUsedBytes: memorySwapMetric(5) }}
        current
        loading={false}
      />,
    );
    expect(markup).toContain("5.00 GiB / 4.00 GiB");
    expect(markup).toContain('aria-label="Swap capacity unavailable"');
    expect(markup).not.toContain("125.00%");
  });
  it("suppresses retained measurements while disconnected", () => {
    const markup = renderToStaticMarkup(
      <ResourceMemorySwap snapshot={memorySwapSnapshot()} current={false} loading={false} />,
    );
    expect(markup).not.toContain('role="meter"');
    expect(markup).not.toContain("53.18");
    expect(markup).not.toContain("28.14");
    expect(markup).not.toContain('data-loading="true"');
  });
  it("uses centered loading states for the initial snapshot", () => {
    const markup = renderToStaticMarkup(
      <ResourceMemorySwap snapshot={null} current={false} loading />,
    );
    expect(markup.match(/data-loading="true"/g)).toHaveLength(2);
    expect(markup.match(/Waiting for capacity data/g)).toHaveLength(2);
    expect(markup).not.toContain('role="meter"');
  });
});
