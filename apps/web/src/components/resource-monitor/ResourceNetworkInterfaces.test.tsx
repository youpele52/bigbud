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
    expect(markup).toContain("Link up");
    expect(markup).toContain("MTU");
    expect(markup).toContain("1,500 B");
    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
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
    expect(markup).toContain("Link denied");
    expect(markup).toContain('title="warming"');
    expect(markup).toContain("Link unavailable");
    expect(markup).not.toContain("0.00 B/s");
    expect(markup).not.toContain("0 B");
  });

  it("uses Download and Upload for interface speeds", () => {
    const markup = renderToStaticMarkup(
      <ResourceNetworkInterfaces
        interfaces={[
          {
            name: "en0",
            receivedBytesPerSecond: { value: 1_024, status: "ready", sampledAtMs: 1 },
            transmittedBytesPerSecond: { value: 2_048, status: "ready", sampledAtMs: 1 },
          },
        ]}
      />,
    );

    expect(markup).toContain(">Download</dt>");
    expect(markup).toContain(">Upload</dt>");
    expect(markup).toContain("1.00 KiB/s");
    expect(markup).toContain("2.00 KiB/s");
    expect(markup).not.toContain("Received");
    expect(markup).not.toContain("Sent");
  });
});
