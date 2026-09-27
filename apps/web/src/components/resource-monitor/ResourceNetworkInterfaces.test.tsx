import type { MonitorNetworkInterface } from "@bigbud/contracts/system-monitor/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResourceNetworkInterfaces } from "./ResourceNetworkInterfaces";

describe("ResourceNetworkInterfaces", () => {
  it("shows Rust-provided link state and MTU", () => {
    const interfaces: MonitorNetworkInterface[] = [
      {
        name: "en0",
        linkState: { value: "up", status: "ready", sampledAtMs: 1 },
        mtuBytes: { value: 1500, status: "ready", sampledAtMs: 1 },
      },
    ];
    const markup = renderToStaticMarkup(<ResourceNetworkInterfaces interfaces={interfaces} />);
    expect(markup).toContain("Link: up");
    expect(markup).toContain("MTU: 1500.00 B");
  });

  it("shows field availability without treating absent values as zero", () => {
    const interfaces: MonitorNetworkInterface[] = [
      {
        name: "eth0",
        linkState: { value: "", status: "denied", sampledAtMs: 1 },
        mtuBytes: { value: 0, status: "warming", sampledAtMs: 1 },
      },
      { name: "wlan0" },
    ];
    const markup = renderToStaticMarkup(<ResourceNetworkInterfaces interfaces={interfaces} />);
    expect(markup).toContain("Link: denied");
    expect(markup).toContain("MTU: warming");
    expect(markup).toContain("Link: unavailable");
    expect(markup).not.toContain("MTU: 0.00 B");
  });
});
