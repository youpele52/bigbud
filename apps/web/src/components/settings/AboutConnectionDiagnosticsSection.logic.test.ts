import type { ServerWsConnectionDiagnosticsSnapshot } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { describe, expect, it } from "vitest";

import {
  buildConnectionTransitionRows,
  describeEventLoopWindow,
  formatDurationMs,
} from "./AboutConnectionDiagnosticsSection.logic";

const snapshot = (
  overrides: Partial<ServerWsConnectionDiagnosticsSnapshot> = {},
): ServerWsConnectionDiagnosticsSnapshot => ({
  capturedAt: "2026-10-21T16:00:10.000Z",
  reports: [],
  serverEvents: [],
  eventLoop: null,
  ...overrides,
});

describe("buildConnectionTransitionRows", () => {
  it("merges app reports and server events newest first", () => {
    const rows = buildConnectionTransitionRows(
      snapshot({
        reports: [
          {
            sequence: 2,
            trigger: "reconnect-success",
            attempt: 3,
            receivedAt: "2026-10-21T16:00:05.000Z",
          },
          {
            sequence: 1,
            trigger: "close",
            attempt: 0,
            closeCode: 1006,
            msSinceLastInboundEvent: 15_000,
            consumerId: "main",
            receivedAt: "2026-10-21T16:00:01.000Z",
          },
        ],
        serverEvents: [
          {
            type: "stalled",
            sequence: 1,
            payload: {
              startedAt: "2026-10-21T15:59:00.000Z",
              endedAt: "2026-10-21T16:00:03.000Z",
              durationMs: 63_000,
              spans: [{ name: "sql.execute", startedAt: "x", endedAt: null }],
              inFlightRpcMethods: [],
            },
          },
        ],
      }),
    );

    expect(rows.map((row) => row.label)).toEqual([
      "Reconnected",
      "Server stalled for 1 min 3 s",
      "Connection closed",
    ]);
    expect(rows.map((row) => row.tone)).toEqual(["success", "warning", "warning"]);
    expect(rows[1]?.details).toEqual(["Running: sql.execute"]);
    expect(rows[2]?.details).toEqual(["Code 1006", "Last message 15.0 s before", "Window main"]);
  });

  it("labels page loads so they do not read as disconnects", () => {
    const [row] = buildConnectionTransitionRows(
      snapshot({
        reports: [
          {
            sequence: 1,
            trigger: "connect",
            reason: "page-load",
            attempt: 0,
            receivedAt: "2026-10-21T16:00:00.000Z",
          },
        ],
      }),
    );
    expect(row).toMatchObject({ label: "Page loaded", tone: "info", details: [] });
  });

  it("describes delivery session ends and caps the list", () => {
    const rows = buildConnectionTransitionRows(
      snapshot({
        serverEvents: Array.from({ length: 25 }, (_, index) => ({
          type: "delivery-session-ended" as const,
          sequence: index + 1,
          at: new Date(Date.UTC(2026, 9, 21, 16, 0, index)).toISOString(),
          consumerId: "floating",
          reason: "overflow" as const,
          durationMs: 1_500,
        })),
      }),
    );
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({
      id: "server-25",
      label: "Live updates fell behind and was reset",
      tone: "warning",
      details: ["After 1.5 s", "Window floating"],
    });
  });

  it("shows a suspected system sleep as a pause, not a stall", () => {
    const rows = buildConnectionTransitionRows(
      snapshot({
        serverEvents: [
          {
            type: "suspected-system-sleep",
            sequence: 4,
            startedAt: "2026-10-21T15:00:00.000Z",
            endedAt: "2026-10-21T15:30:00.000Z",
            durationMs: 1_800_000,
          },
        ],
      }),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: "server-4",
        at: "2026-10-21T15:30:00.000Z",
        source: "server",
        label: "Server paused for 30 min 0 s, likely system sleep",
        tone: "info",
      }),
    ]);
  });
});

describe("describeEventLoopWindow", () => {
  it("summarizes the latest window", () => {
    expect(describeEventLoopWindow(null)).toBe("No measurement yet.");
    expect(
      describeEventLoopWindow({
        endedAt: "2026-10-21T16:00:00.000Z",
        windowMs: 10_000,
        p50Ms: 1,
        p99Ms: 42,
        maxMs: 1_250,
        stallCount: 1,
      }),
    ).toBe("p99 42 ms, max 1.3 s, 1 stall in the last 10.0 s.");
    expect(formatDurationMs(999)).toBe("999 ms");
  });
});
