import { describe, expect, it } from "vitest";

import { analyzeServerChildLog, analyzeTrace } from "./connection-health-report.lib.ts";

// Shapes copied from a packaged macOS server-child.log on 2026-11-05.
const childLog = [
  "[18:41:38.686] INFO (#750037): [DiscoveryRegistry] scanDiscoveryFiles: 528 files found from 51 descriptors",
  "[18:41:39.344] INFO (#750624): [DiscoveryRegistry] scanDiscoveryFiles: 528 files found from 51 descriptors",
  "[18:52:00.000] INFO (#750625): [DiscoveryRegistry] scanDiscoveryFiles: 528 files found from 51 descriptors",
  "[18:42:07.499] WARN (#93): server event loop stalled",
  "  stall.duration_ms: 4922",
  "[18:43:07.499] WARN (#93): server event loop stalled",
  "  stall.duration_ms: 29125",
  "[84853:0x138005d0000]  1025118 ms: Mark-Compact (reduce) 1254.0 (1339.2) -> 1253.8 (1256.9) MB, pooled: 0.0 MB, 45.73 / 0.00 ms (average mu = 0.958, current mu = 0.125) last resort; GC in old space requested",
  "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory",
  // The desktop shell echoes the same stderr tail into the log after the exit.
  "[84853:0x138005d0000]  1025118 ms: Mark-Compact (reduce) 1254.0 (1339.2) -> 1253.8 (1256.9) MB, pooled: 0.0 MB, 45.73 / 0.00 ms (average mu = 0.958, current mu = 0.125) last resort; GC in old space requested",
  "[38258:0x108022d0000]  2783696 ms: Mark-Compact (reduce) 309.3 (373.9) -> 309.3 (310.9) MB, pooled: 0.0 MB, 3.88 / 0.00 ms (average mu = 0.998, current mu = 0.588) last resort; GC in old space requested",
  "[38258:0x108022d0000]  2783000 ms: Mark-Compact 200.0 (210.0) -> 190.0 (200.0) MB, routine collection",
].join("\n");

const scan = (clock: string) =>
  `[${clock}] INFO (#1): [DiscoveryRegistry] scanDiscoveryFiles: 528 files found`;

describe("analyzeServerChildLog", () => {
  it("counts distinct out-of-memory processes, stalls and discovery scan bursts", () => {
    expect(analyzeServerChildLog(childLog)).toEqual({
      heapOutOfMemoryAborts: 2,
      stalls: { overOneSecond: 2, overFiveSeconds: 1 },
      longestStallMs: 29_125,
      discoveryScans: 3,
      peakDiscoveryScansPerTenMinutes: 2,
    });
  });

  it("keeps the same clock time on different days in separate windows", () => {
    const twoDays = [
      scan("17:21:00.000"),
      scan("17:22:00.000"),
      "[23:59:00.000] INFO (#1): late on day one",
      "[00:01:00.000] INFO (#1): early on day two",
      scan("17:23:00.000"),
    ].join("\n");

    expect(analyzeServerChildLog(twoDays).peakDiscoveryScansPerTenMinutes).toBe(2);
  });

  it("reports zeros for an empty log", () => {
    expect(analyzeServerChildLog("")).toMatchObject({
      heapOutOfMemoryAborts: 0,
      peakDiscoveryScansPerTenMinutes: 0,
    });
  });
});

const span = (name: string, startMs: number, attributes: Record<string, unknown>, durationMs = 1) =>
  JSON.stringify({
    type: "effect-span",
    name,
    startTimeUnixNano: String(startMs * 1_000_000),
    durationMs,
    attributes,
  });

describe("analyzeTrace", () => {
  it("flags a reconnect that never opened a new delivery session", () => {
    const base = 1_793_896_000_000;
    const lines = [
      // Consumer A: socket reopened at +0, new delivery session opened at +2 s. Healthy.
      span("ws.connection.diagnostics", base, {
        "connection.trigger": "reconnect-success",
        "connection.consumer_id": "consumer-a",
      }),
      span("orchestration.delivery.session.ended", base + 600_000, {
        "delivery.consumer_id": "consumer-a",
        "delivery.duration_ms": 598_000,
      }),
      // Consumer B: socket reopened after a ping timeout; no session until an old one ended.
      span("ws.connection.diagnostics", base + 10_000, {
        "connection.trigger": "reconnect-success",
        "connection.consumer_id": "consumer-b",
      }),
      span("orchestration.delivery.session.ended", base + 9_000, {
        "delivery.consumer_id": "consumer-b",
        "delivery.duration_ms": 200_000,
      }),
      span("server.stalled", base, { "stall.duration_ms": 7_955 }),
      span("server.stalled", base, { "stall.duration_ms": 1_200 }),
      span("sql.execute", base, {}, 73_686),
      span("sql.execute", base, {}, 9_000),
      "not json",
    ];

    expect(analyzeTrace(lines)).toEqual({
      stallsOverFiveSeconds: 1,
      sqlSpansOverTenSeconds: 1,
      reconnects: 2,
      reconnectsWithoutDeliverySession: 1,
    });
  });
});
