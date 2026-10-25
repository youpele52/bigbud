import { WS_CONNECTION_DIAGNOSTICS_PAGE_LOAD_REASON } from "@bigbud/contracts/constants/connectionDiagnostics.constant.ts";
import type { WsConnectionDiagnosticsReport } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getWsConnectionStatus,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "./wsConnectionState";
import {
  attachWsConnectionDiagnosticsSender,
  getPendingWsConnectionDiagnosticsReportsForTests,
  queueWsConnectionDiagnosticsReport,
  resetWsConnectionDiagnosticsReporterForTests,
  WS_CONNECTION_DIAGNOSTICS_MAX_PENDING,
  WS_CONNECTION_DIAGNOSTICS_MAX_SEND_ATTEMPTS,
  wsConnectionDiagnosticsLifecycle,
} from "./wsConnectionDiagnosticsReporter";

const lifecycle = wsConnectionDiagnosticsLifecycle;

function attempt() {
  lifecycle.onAttempt?.("ws://localhost:3020/ws");
  return recordWsConnectionAttempt("ws://localhost:3020/ws").reconnectAttemptCount;
}

/** Mirrors the protocol layer: the attempt count is captured before the open resets it. */
function open() {
  const reconnectAttempt = attempt();
  recordWsConnectionOpened();
  lifecycle.onOpen?.({ reconnectAttempt });
}

function drop(code = 1006, reason = "dropped") {
  recordWsConnectionClosed({ code, reason });
  lifecycle.onClose?.({ code, reason });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage: { getItem: () => "consumer-1" } },
  });
  resetWsConnectionStateForTests();
  resetWsConnectionDiagnosticsReporterForTests();
});

afterEach(() => {
  resetWsConnectionDiagnosticsReporterForTests();
  resetWsConnectionStateForTests();
});

describe("connection diagnostics reporter", () => {
  it("tags the first connect after a page load and later opens as reconnects", async () => {
    const sent: WsConnectionDiagnosticsReport[] = [];
    attachWsConnectionDiagnosticsSender(async (report) => sent.push(report));
    open();
    drop();
    open();
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((report) => report.trigger)).toEqual(["connect", "close", "reconnect-success"]);
    expect(sent[0]).toMatchObject({
      reason: WS_CONNECTION_DIAGNOSTICS_PAGE_LOAD_REASON,
      consumerId: "consumer-1",
    });
    expect(sent[1]).toMatchObject({ closeCode: 1006, closeReason: "dropped" });
    expect(sent[2]?.reason).toBeUndefined();
  });

  it("holds reports while disconnected and flushes them in order after reconnect", async () => {
    const sent: WsConnectionDiagnosticsReport[] = [];
    attachWsConnectionDiagnosticsSender(async (report) => sent.push(report));
    open();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    drop();
    queueWsConnectionDiagnosticsReport({ trigger: "heartbeat-failure", detail: "x".repeat(2_000) });
    expect(sent).toHaveLength(1);
    expect(getPendingWsConnectionDiagnosticsReportsForTests()).toHaveLength(2);
    open();
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    expect(sent.slice(1).map((report) => report.trigger)).toEqual([
      "close",
      "heartbeat-failure",
      "reconnect-success",
    ]);
    expect(sent[2]?.detail?.length).toBe(512);
  });

  it("bounds the pending queue during long outages", () => {
    open();
    drop();
    for (let index = 0; index < WS_CONNECTION_DIAGNOSTICS_MAX_PENDING * 2; index += 1) {
      queueWsConnectionDiagnosticsReport({ trigger: "error" });
    }
    expect(getPendingWsConnectionDiagnosticsReportsForTests()).toHaveLength(
      WS_CONNECTION_DIAGNOSTICS_MAX_PENDING,
    );
  });

  it("stops reporting against a server without the report RPC", async () => {
    const send = vi.fn(async () => {
      throw new Error("Unknown request tag: server.reportWsConnectionDiagnostics");
    });
    attachWsConnectionDiagnosticsSender(send);
    open();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    drop();
    open();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).toHaveBeenCalledOnce();
    expect(getPendingWsConnectionDiagnosticsReportsForTests()).toHaveLength(0);
  });

  it("drops a rejected report while connected so later reports still go out", async () => {
    const sent: string[] = [];
    let rejectNext = true;
    attachWsConnectionDiagnosticsSender(async (report) => {
      if (rejectNext) {
        rejectNext = false;
        throw new Error("schema rejected");
      }
      sent.push(report.trigger);
    });
    open();
    queueWsConnectionDiagnosticsReport({ trigger: "protocol-failure" });
    await vi.waitFor(() => expect(sent).toEqual(["protocol-failure"]));
  });

  it("keeps occurredAt from when the event happened, not when it was delivered", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-10-21T15:00:00.000Z"));
      const sent: WsConnectionDiagnosticsReport[] = [];
      attachWsConnectionDiagnosticsSender(async (report) => sent.push(report));
      open();
      drop();
      vi.setSystemTime(Date.parse("2026-10-21T15:05:00.000Z"));
      open();
      await vi.waitFor(() => expect(sent).toHaveLength(3));
      expect(sent[1]?.occurredAt).toBe("2026-10-21T15:00:00.000Z");
      expect(sent[2]?.occurredAt).toBe("2026-10-21T15:05:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a report after a bounded number of connections instead of looping", async () => {
    let calls = 0;
    attachWsConnectionDiagnosticsSender(async () => {
      calls += 1;
      // Each delivery attempt meets a socket that drops again.
      recordWsConnectionClosed({ code: 1006, reason: "dropped" });
      throw new Error("socket closed");
    });
    queueWsConnectionDiagnosticsReport({ trigger: "error" });
    for (let index = 0; index < WS_CONNECTION_DIAGNOSTICS_MAX_SEND_ATTEMPTS + 2; index += 1) {
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionOpened();
      queueWsConnectionDiagnosticsReport({ trigger: "reconnect-success" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(
      getPendingWsConnectionDiagnosticsReportsForTests().some(
        (report) => report.trigger === "error",
      ),
    ).toBe(false);
    expect(calls).toBeLessThanOrEqual((WS_CONNECTION_DIAGNOSTICS_MAX_SEND_ATTEMPTS + 2) * 2);
  });

  it("reports the first drop of an outage in full and collapses later attempts", async () => {
    const sent: WsConnectionDiagnosticsReport[] = [];
    attachWsConnectionDiagnosticsSender(async (report) => sent.push(report));
    open();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // The live socket's own error and close are the original cause.
    lifecycle.onError?.("Unable to connect");
    drop(1006, "server froze");
    for (let index = 0; index < WS_CONNECTION_DIAGNOSTICS_MAX_PENDING * 2; index += 1) {
      attempt();
      lifecycle.onError?.("Unable to connect");
      drop(1006, "");
    }
    expect(getPendingWsConnectionDiagnosticsReportsForTests().map((r) => r.trigger)).toEqual([
      "error",
      "close",
    ]);
    open();
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    expect(sent[2]).toMatchObject({ trigger: "close", closeReason: "server froze" });
    expect(sent[3]).toMatchObject({
      trigger: "reconnect-success",
      attempt: WS_CONNECTION_DIAGNOSTICS_MAX_PENDING * 2 + 1,
      detail: `collapsedFailedAttempts=${WS_CONNECTION_DIAGNOSTICS_MAX_PENDING * 2}; lastCloseCode=1006`,
    });

    // The next outage starts fresh and is again reported in full.
    drop(1001, "second outage");
    expect(getPendingWsConnectionDiagnosticsReportsForTests().at(-1)).toMatchObject({
      trigger: "close",
      closeReason: "second outage",
    });
  });

  it("never blocks the caller or the connection while a report hangs", () => {
    const send = vi.fn(() => new Promise<never>(() => undefined));
    attachWsConnectionDiagnosticsSender(send);
    open();
    queueWsConnectionDiagnosticsReport({ trigger: "heartbeat-failure" });
    queueWsConnectionDiagnosticsReport({ trigger: "protocol-failure" });
    // Synchronous return, one report in flight at a time, no reconnect side effects.
    expect(send).toHaveBeenCalledOnce();
    expect(getWsConnectionStatus().phase).toBe("connected");
  });
});
