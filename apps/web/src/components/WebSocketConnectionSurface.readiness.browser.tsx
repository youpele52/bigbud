import "../index.css";
import { ConnectIcon } from "@hugeicons/core-free-icons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";

import { resetServerStateForTests, setServerConfigSnapshot } from "../rpc/serverState";
import { serverConfigFixture } from "../rpc/serverConfig.test.fixture";
import {
  beginServerConfigReadiness,
  updateServerConfigReadiness,
} from "../rpc/serverConfigReadiness";
import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState";
import { WebSocketConnectionSurface } from "./WebSocketConnectionSurface";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { registerServerConfigRetry } from "../rpc/serverConfigReadiness";
import { recordWsProtocolRecovery } from "../rpc/wsConnectionState";

const mocks = vi.hoisted(() => ({
  startup: null as DesktopBackendStartupState | null,
  reconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("../rpc/wsRpcClient", () => ({
  getWsRpcClient: () => ({ reconnect: mocks.reconnect, reconnectNow: () => false }),
}));

// Only the native startup IPC boundary is mocked. The surface, readiness and config atoms are real.
vi.mock("./DesktopBackendStartupCoordinator", () => ({
  useDesktopBackendStartupState: () => mocks.startup,
}));

beforeEach(() => {
  mocks.startup = null;
  resetServerStateForTests();
  resetWsConnectionStateForTests();
});
afterEach(() => {
  resetServerStateForTests();
  resetWsConnectionStateForTests();
  mocks.reconnect.mockClear();
});

describe("real config readiness surface", () => {
  it("shows an intentional handoff even when configuration was previously loaded", async () => {
    setServerConfigSnapshot(serverConfigFixture);
    mocks.startup = {
      generation: 1,
      startedAt: 1,
      status: "failed",
      ownershipRecovery: { phase: "yielded" },
    };
    const screen = await render(
      <AppAtomRegistryProvider>
        <WebSocketConnectionSurface>
          <main>Normal shell</main>
        </WebSocketConnectionSurface>
      </AppAtomRegistryProvider>,
    );
    await expect.element(screen.getByText(/another bigbud window could use/)).toBeVisible();
    await expect.element(screen.getByText("Normal shell")).not.toBeInTheDocument();
  });
  it("renders the normal shell during the initial config grace period", async () => {
    const screen = await render(
      <AppAtomRegistryProvider>
        <WebSocketConnectionSurface>
          <main>Normal shell</main>
        </WebSocketConnectionSurface>
      </AppAtomRegistryProvider>,
    );
    await expect.element(screen.getByText("Normal shell")).toBeVisible();
  });

  it("reports a config failure while honestly describing an open socket and redacting details", async () => {
    recordWsConnectionAttempt("ws://user:password@localhost:3020/ws?token=private-token");
    recordWsConnectionOpened();
    const generation = beginServerConfigReadiness(false);
    updateServerConfigReadiness(generation, {
      fallback: "failed",
      failure: "fallback_failed",
      stream: "exhausted",
      failures: 3,
    });
    const screen = await render(
      <AppAtomRegistryProvider>
        <WebSocketConnectionSurface>
          <main>Normal shell</main>
        </WebSocketConnectionSurface>
      </AppAtomRegistryProvider>,
    );
    await expect.element(screen.getByText("Server configuration unavailable")).toBeVisible();
    await expect.element(screen.getByText("Connected; configuration pending")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Retry configuration" })).toBeVisible();
    expect(document.body.textContent).not.toContain("private-token");
    expect(document.body.textContent).not.toContain("password");
    expect(document.body.textContent).not.toContain("Opening WebSocket");
  });

  it("keeps a loaded shell available during a later config failure", async () => {
    setServerConfigSnapshot(serverConfigFixture);
    const generation = beginServerConfigReadiness(true);
    updateServerConfigReadiness(generation, {
      stream: "exhausted",
      failure: "subscription_failed",
    });
    const screen = await render(
      <AppAtomRegistryProvider>
        <WebSocketConnectionSurface>
          <main>Retained shell</main>
        </WebSocketConnectionSurface>
      </AppAtomRegistryProvider>,
    );
    await expect.element(screen.getByText("Retained shell")).toBeVisible();
    expect(document.body.textContent).not.toContain("Server configuration unavailable");
  });

  it("offers logical retry for a confirmed fallback failure even before stream exhaustion", async () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    const generation = beginServerConfigReadiness(false);
    updateServerConfigReadiness(generation, { fallback: "failed", failure: "fallback_failed" });
    const retry = vi.fn();
    const stop = registerServerConfigRetry(generation, retry);
    try {
      const screen = await render(
        <AppAtomRegistryProvider>
          <WebSocketConnectionSurface>
            <main>Shell</main>
          </WebSocketConnectionSurface>
        </AppAtomRegistryProvider>,
      );
      await screen.getByRole("button", { name: "Retry configuration" }).click();
      expect(retry).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it("keeps recovery styling and ConnectIcon when reconnect changes to configuration retry", async () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsProtocolRecovery();
    const generation = beginServerConfigReadiness(false);
    updateServerConfigReadiness(generation, { stream: "exhausted", failure: "protocol_failed" });
    const retry = vi.fn();
    const stop = registerServerConfigRetry(generation, retry);
    try {
      const screen = await render(
        <AppAtomRegistryProvider>
          <WebSocketConnectionSurface>
            <main>Shell</main>
          </WebSocketConnectionSurface>
        </AppAtomRegistryProvider>,
      );
      const reconnect = screen.getByRole("button", { name: "Reconnect", exact: true });
      await expect.element(reconnect).toBeVisible();
      const reconnectClasses = reconnect.element().className;

      recordWsConnectionOpened();

      const configurationRetry = screen.getByRole("button", {
        name: "Retry configuration",
        exact: true,
      });
      await expect.element(configurationRetry).toHaveClass("text-muted-foreground");
      expect(configurationRetry.element().className).toBe(reconnectClasses);
      expect(
        Array.from(configurationRetry.element().querySelectorAll("svg path"), (path) =>
          path.getAttribute("d"),
        ),
      ).toEqual(ConnectIcon.map(([, attributes]) => attributes.d));
      expect(getComputedStyle(configurationRetry.element().parentElement!).justifyContent).toBe(
        "center",
      );
      await expect
        .element(screen.getByRole("button", { name: "Reload app", exact: true }))
        .toHaveClass("bg-primary");
      await configurationRetry.click();
      expect(retry).toHaveBeenCalledOnce();
      expect(mocks.reconnect).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("offers physical reconnect without reload and re-establishes a stopped config owner", async () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsProtocolRecovery();
    const generation = beginServerConfigReadiness(false);
    updateServerConfigReadiness(generation, { stream: "exhausted", failure: "protocol_failed" });
    const retry = vi.fn();
    const stop = registerServerConfigRetry(generation, retry, () => true);
    try {
      const screen = await render(
        <AppAtomRegistryProvider>
          <WebSocketConnectionSurface>
            <main>Shell</main>
          </WebSocketConnectionSurface>
        </AppAtomRegistryProvider>,
      );
      await expect
        .element(screen.getByRole("button", { name: "Reconnect", exact: true }))
        .toHaveClass("text-muted-foreground");
      await expect
        .element(screen.getByRole("button", { name: "Reload app", exact: true }))
        .toHaveClass("bg-primary");
      const reconnect = screen.getByRole("button", { name: "Reconnect", exact: true }).element();
      expect(getComputedStyle(reconnect.parentElement!).justifyContent).toBe("center");
      expect(reconnect.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      expect(
        Array.from(reconnect.querySelectorAll("svg path"), (path) => path.getAttribute("d")),
      ).toEqual(ConnectIcon.map(([, attributes]) => attributes.d));
      await screen.getByRole("button", { name: "Reconnect", exact: true }).click();
      await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
      expect(mocks.reconnect).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });
});
