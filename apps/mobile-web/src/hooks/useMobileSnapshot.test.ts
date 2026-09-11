import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  queryResult: {
    data: undefined,
    refetch: vi.fn(async () => ({ data: undefined })),
  },
  rpc: {
    client: { getSnapshot: vi.fn() },
    connection: {},
    recovery: null as { refresh: ReturnType<typeof vi.fn> } | null,
    recoveryState: { freshness: "unavailable" },
    restart: vi.fn(),
  },
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: mockState.useQuery,
}));

vi.mock("../context/MobileRpcContext", () => ({
  useMobileRpcClient: () => mockState.rpc,
}));

import { useMobileSnapshot } from "./useMobileSnapshot";

describe("useMobileSnapshot", () => {
  beforeEach(() => {
    mockState.queryResult = {
      data: undefined,
      refetch: vi.fn(async () => ({ data: undefined })),
    };
    mockState.rpc = {
      client: { getSnapshot: vi.fn() },
      connection: {},
      recovery: null,
      recoveryState: { freshness: "unavailable" },
      restart: vi.fn(),
    };
    mockState.useQuery.mockReset();
    mockState.useQuery.mockReturnValue(mockState.queryResult);
  });

  function renderHook() {
    let result: ReturnType<typeof useMobileSnapshot> | undefined;
    function Capture() {
      result = useMobileSnapshot({ sessionId: "session-1" });
      return null;
    }
    renderToStaticMarkup(createElement(Capture));
    return result!;
  }

  it("enables the snapshot query for legacy recovery", () => {
    mockState.rpc.recoveryState = { freshness: "legacy" };

    renderHook();

    expect(mockState.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        queryKey: ["mobile-snapshot", "session-1"],
      }),
    );
  });

  it("keeps the snapshot query disabled while recovery owns refreshes", () => {
    mockState.rpc.recoveryState = { freshness: "current" };

    renderHook();

    expect(mockState.useQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("keeps public refetch delegated to the recovery controller", async () => {
    const refresh = vi.fn(async () => undefined);
    mockState.rpc.recovery = { refresh };
    mockState.rpc.recoveryState = { freshness: "legacy" };

    const result = renderHook();
    await result.snapshotQuery.refetch();

    expect(refresh).toHaveBeenCalledOnce();
    expect(mockState.queryResult.refetch).not.toHaveBeenCalled();
  });
});
