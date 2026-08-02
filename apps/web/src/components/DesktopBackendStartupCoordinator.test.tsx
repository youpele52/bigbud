import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import { WebSocketBlockingState } from "./WebSocketConnectionSurface.blocking";
import {
  shouldContinueDesktopStartupReconnect,
  shouldReconnectAfterTimedOutDesktopStartup,
  shouldShowDesktopStartupBlockingState,
} from "./WebSocketConnectionSurface.logic";
import { getInitialDesktopBackendStartupState } from "./DesktopBackendStartupCoordinator";

function startup(
  status: DesktopBackendStartupState["status"],
  generation = 1,
): DesktopBackendStartupState {
  return { generation, startedAt: 0, status };
}

function connectionStatus(): WsConnectionStatus {
  return {
    attemptCount: 0,
    closeCode: null,
    closeReason: null,
    connectedAt: null,
    disconnectedAt: null,
    hasConnected: false,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase: "connecting",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketUrl: null,
  };
}

describe("desktop backend startup UX", () => {
  it.each([
    ["failed", "Local backend stopped during startup", "could not finish starting"],
    [
      "timedOut",
      "Local backend startup is taking too long",
      "taking longer than expected to start",
    ],
  ] as const)("immediately blocks for %s desktop startup", (status, title, description) => {
    const backendStartup = startup(status);

    expect(shouldShowDesktopStartupBlockingState(backendStartup)).toBe(true);
    expect(
      renderToStaticMarkup(
        <WebSocketBlockingState
          desktopStartup={backendStartup}
          status={connectionStatus()}
          uiState="connecting"
        />,
      ),
    ).toContain(title);
    expect(
      renderToStaticMarkup(
        <WebSocketBlockingState
          desktopStartup={backendStartup}
          status={connectionStatus()}
          uiState="connecting"
        />,
      ),
    ).toContain(description);
  });

  it("continues retrying before the deadline and reconnects only after same-generation late ready", () => {
    expect(shouldShowDesktopStartupBlockingState(null)).toBe(false);
    expect(shouldShowDesktopStartupBlockingState(startup("starting"))).toBe(false);
    expect(shouldContinueDesktopStartupReconnect(startup("starting"))).toBe(true);
    expect(shouldShowDesktopStartupBlockingState(startup("timedOut"))).toBe(true);
    expect(shouldContinueDesktopStartupReconnect(startup("timedOut"))).toBe(false);
    expect(shouldShowDesktopStartupBlockingState(startup("ready"))).toBe(false);
    expect(shouldReconnectAfterTimedOutDesktopStartup(true, null, startup("ready"))).toBe(false);
    expect(
      shouldReconnectAfterTimedOutDesktopStartup(true, startup("starting"), startup("ready")),
    ).toBe(false);
    expect(
      shouldReconnectAfterTimedOutDesktopStartup(true, startup("timedOut"), startup("ready")),
    ).toBe(true);
    expect(
      shouldReconnectAfterTimedOutDesktopStartup(true, startup("timedOut", 1), startup("ready", 2)),
    ).toBe(false);
    expect(
      shouldReconnectAfterTimedOutDesktopStartup(false, startup("timedOut"), startup("ready")),
    ).toBe(false);
  });

  it("recovers when the desktop startup IPC fetch rejects", async () => {
    await expect(
      getInitialDesktopBackendStartupState(async () =>
        Promise.reject(new Error("IPC unavailable")),
      ),
    ).resolves.toBeNull();
  });

  it("shows sanitized technical details only for desktop startup failures", () => {
    const failure: DesktopBackendStartupState = {
      diagnostics: {
        category: "process",
        errorMessage: "Backend exited.",
        occurredAt: "2026-01-01T00:00:00.000Z",
        stderrTail: "safe stderr",
      },
      failureReason: "child_exit_before_ready",
      generation: 1,
      startedAt: 0,
      status: "failed",
    };
    const rendered = renderToStaticMarkup(
      <WebSocketBlockingState
        desktopStartup={failure}
        status={connectionStatus()}
        uiState="connecting"
      />,
    );
    expect(rendered).toContain("Show technical details");
    expect(rendered).toContain("safe stderr");
    expect(
      renderToStaticMarkup(
        <WebSocketBlockingState
          desktopStartup={null}
          status={connectionStatus()}
          uiState="error"
        />,
      ),
    ).not.toContain("Show technical details");
  });

  it("shows development crash context only when Electron supplied it", () => {
    const production = startup("failed");
    const development: DesktopBackendStartupState = {
      ...production,
      developmentDiagnostics: {
        capturedAt: "2026-01-01T00:00:01.000Z",
        errorStack: "Error: local crash\n    at server.ts:1",
        stderrTail: "development stderr",
      },
      diagnostics: { category: "process", occurredAt: "2026-01-01T00:00:00.000Z" },
      failureReason: "child_exit_before_ready",
    };
    expect(
      renderToStaticMarkup(
        <WebSocketBlockingState
          desktopStartup={development}
          status={connectionStatus()}
          uiState="connecting"
        />,
      ),
    ).toContain("development stderr");
    expect(
      renderToStaticMarkup(
        <WebSocketBlockingState
          desktopStartup={{ ...development, developmentDiagnostics: undefined }}
          status={connectionStatus()}
          uiState="connecting"
        />,
      ),
    ).not.toContain("development stderr");
  });
});
