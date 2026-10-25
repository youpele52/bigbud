// The settings Connection section reads through the real native API into the RPC client.
import "../index.css";

import type { ServerWsConnectionDiagnosticsSnapshot } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  getWsConnectionDiagnostics: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

/** Any RPC the native API wires up at creation; only the diagnostics read matters here. */
function rpcClientStub(): unknown {
  const branches = new Map<PropertyKey, unknown>();
  return new Proxy(() => undefined, {
    get: (_target, key) => {
      if (key === "then") return undefined;
      if (!branches.has(key)) branches.set(key, rpcClientStub());
      return branches.get(key);
    },
  });
}

vi.mock("../rpc/wsRpcClient", () => {
  const client = rpcClientStub() as { server: Record<string, unknown> };
  return {
    getWsRpcClient: () =>
      new Proxy(client, {
        get: (target, key) =>
          key === "server"
            ? new Proxy(target.server, {
                get: (server, method) =>
                  method === "getWsConnectionDiagnostics"
                    ? mocks.getWsConnectionDiagnostics
                    : server[method as string],
              })
            : target[key as keyof typeof target],
      }),
    __resetWsRpcClientForTests: () => undefined,
  };
});

import { __resetNativeApiForTests } from "../rpc/nativeApi";
import { AboutConnectionDiagnosticsSection } from "./settings/AboutConnectionDiagnosticsSection";

const snapshot: ServerWsConnectionDiagnosticsSnapshot = {
  capturedAt: "2026-10-21T16:00:10.000Z",
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
      receivedAt: "2026-10-21T16:00:01.000Z",
    },
  ],
  serverEvents: [],
  eventLoop: null,
};

afterEach(() => {
  __resetNativeApiForTests();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("settings connection diagnostics", () => {
  it("renders the server's recorded transitions instead of 'not available'", async () => {
    mocks.getWsConnectionDiagnostics.mockResolvedValue(snapshot);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <AboutConnectionDiagnosticsSection />
      </QueryClientProvider>,
    );

    await expect.element(screen.getByText("Reconnected")).toBeVisible();
    await expect.element(screen.getByText("Connection closed")).toBeVisible();
    expect(mocks.getWsConnectionDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ limit: expect.any(Number) }),
    );
    expect(document.body.textContent).not.toContain("Not available in this build.");
    queryClient.clear();
  });
});
