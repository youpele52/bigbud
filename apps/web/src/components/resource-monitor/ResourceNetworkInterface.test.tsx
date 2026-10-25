import type { MonitorTextField } from "@bigbud/contracts/system-monitor/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResourceNetworkInterface } from "./ResourceNetworkInterface";
import { ResourceNetworkInterfaceContent } from "./ResourceNetworkInterfaceContent";
import { ResourceNetworkInterfaces } from "./ResourceNetworkInterfaces";
import { interfaceMetric, monitorInterfaces } from "./ResourceNetworkInterfaces.fixtures";

describe("interface inset cards", () => {
  it.each<{ field?: MonitorTextField; current: boolean; label: string; color: string }>([
    {
      field: { value: "up", status: "ready", sampledAtMs: 1 },
      current: true,
      label: "Link up",
      color: "bg-success",
    },
    {
      field: { value: "down", status: "ready", sampledAtMs: 1 },
      current: true,
      label: "Link down",
      color: "bg-destructive",
    },
    { current: true, label: "Link unavailable", color: "bg-muted-foreground" },
    {
      field: { value: "up", status: "stale", sampledAtMs: 1 },
      current: true,
      label: "Link stale",
      color: "bg-muted-foreground",
    },
    {
      field: { value: "up", status: "denied", sampledAtMs: 1 },
      current: true,
      label: "Link denied",
      color: "bg-muted-foreground",
    },
    {
      field: { value: "unknown", status: "ready", sampledAtMs: 1 },
      current: true,
      label: "Link unknown",
      color: "bg-muted-foreground",
    },
    {
      field: { value: "up", status: "ready", sampledAtMs: 1 },
      current: false,
      label: "Link unavailable",
      color: "bg-muted-foreground",
    },
    {
      field: { value: "down", status: "ready", sampledAtMs: 1 },
      current: false,
      label: "Link unavailable",
      color: "bg-muted-foreground",
    },
  ])(
    "uses an accessible $color dot for $label (current: $current)",
    ({ field, current, label, color }) => {
      for (const expanded of [false, true]) {
        const markup = renderToStaticMarkup(
          <ResourceNetworkInterfaceContent
            item={{ name: "en0", ...(field ? { linkState: field } : {}) }}
            history={[]}
            showHistory={false}
            current={current}
            expanded={expanded}
          />,
        );
        expect(markup).toContain(
          `role="img" aria-label="${label}" title="${label}" class="size-2 shrink-0 rounded-full ${color}"`,
        );
        expect(markup).not.toContain(`>${label}<`);
        expect(markup).not.toContain('data-slot="badge"');
        expect(markup).not.toContain("animate-pulse");
        expect(markup).not.toContain("animate-breathe");
      }
    },
  );
  it("defaults to visible fixed-height history, puts totals apart from rates, and keeps details closed", () => {
    const markup = renderToStaticMarkup(
      <ResourceNetworkInterfaces interfaces={monitorInterfaces()} />,
    );
    expect(markup).toContain('aria-pressed="true"');
    expect(markup.match(/data-slot="interface-history"/g)).toHaveLength(3);
    expect(markup).toContain("Downloaded total");
    expect(markup).toContain("Uploaded total");
    expect(markup).toContain("79.90 GiB");
    expect(markup).not.toContain("open=");
    expect(markup).toContain("Bridges and tunnels can count the same traffic");
  });
  it("sorts by name instead of traffic and never mutates the supplied interface list", () => {
    const items = monitorInterfaces();
    const markup = renderToStaticMarkup(<ResourceNetworkInterfaces interfaces={items} />);
    expect(markup.indexOf("awdl0 network interface")).toBeLessThan(
      markup.indexOf("bridge0 network interface"),
    );
    expect(markup.indexOf("bridge0 network interface")).toBeLessThan(
      markup.indexOf("en0 network interface"),
    );
    expect(items[0]!.name).toBe("en0");
  });
  it("provides a small named zoom trigger on each compact header", () => {
    const markup = renderToStaticMarkup(
      <ResourceNetworkInterfaces interfaces={monitorInterfaces()} />,
    );
    for (const item of monitorInterfaces())
      expect(markup).toContain(`aria-label="Expand ${item.name} network interface"`);
    expect(markup.match(/aria-label="Expand /g)).toHaveLength(3);
  });
  it("reuses rates and totals in the larger view with all technical details exposed", () => {
    const markup = renderToStaticMarkup(
      <ResourceNetworkInterfaceContent
        item={monitorInterfaces()[0]!}
        history={[]}
        showHistory
        current
        expanded
      />,
    );
    expect(markup).toContain("h-64");
    expect(markup).toContain("1.40 MiB/s");
    expect(markup).toContain("79.90 GiB");
    expect(markup).toContain("1,500 B");
    expect(markup).toContain("Receive errors");
    expect(markup).not.toContain("<details");
  });
  it("hides old link and current-rate claims while disconnected", () => {
    const markup = renderToStaticMarkup(
      <ResourceNetworkInterface
        item={monitorInterfaces()[0]!}
        history={[]}
        showHistory
        current={false}
      />,
    );
    expect(markup).toContain("Link unavailable");
    expect(markup).toContain("Network measurements unavailable");
    expect(markup).not.toContain("1.40 MiB/s");
    expect(markup).not.toContain("animate-breathe");
  });
  it.each([-1, NaN, Infinity])("does not display invalid rate %s as measured activity", (value) => {
    const markup = renderToStaticMarkup(
      <ResourceNetworkInterface
        item={{ name: "en0", receivedBytesPerSecond: interfaceMetric(value) }}
        history={[]}
        showHistory
        current
      />,
    );
    expect(markup).not.toContain("B/s");
    expect(markup).toContain("Network measurements unavailable");
  });
  it("keeps genuine zero transfer measurements and hidden error counters without implying new failures", () => {
    const markup = renderToStaticMarkup(
      <ResourceNetworkInterface
        item={monitorInterfaces()[1]!}
        history={[]}
        showHistory={false}
        current
      />,
    );
    expect(markup.match(/0.00 B\/s/g)).toHaveLength(2);
    expect(markup).toContain("Receive errors");
    expect(markup).not.toContain('data-slot="interface-history"');
    expect(markup).not.toContain("text-destructive");
  });
});
