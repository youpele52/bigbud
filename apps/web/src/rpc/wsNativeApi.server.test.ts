import { DEFAULT_SERVER_SETTINGS, type ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { baseServerConfig, defaultProviders, rpcClientMock } from "./wsNativeApi.test.helpers";

describe("wsNativeApi — server", () => {
  it("forwards server config fetches directly to the RPC client", async () => {
    rpcClientMock.server.getConfig.mockResolvedValue(baseServerConfig);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.getConfig()).resolves.toEqual(baseServerConfig);
    expect(rpcClientMock.server.getConfig).toHaveBeenCalledWith();
    expect(rpcClientMock.server.subscribeConfig).not.toHaveBeenCalled();
    expect(rpcClientMock.server.subscribeLifecycle).not.toHaveBeenCalled();
  });

  it("forwards provider refreshes directly to the RPC client", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        checkedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    rpcClientMock.server.refreshProviders.mockResolvedValue({ providers: nextProviders });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.refreshProviders()).resolves.toEqual({ providers: nextProviders });
    expect(rpcClientMock.server.refreshProviders).toHaveBeenCalledWith();
  });

  it("forwards server settings updates directly to the RPC client", async () => {
    const nextSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: true,
    };
    rpcClientMock.server.updateSettings.mockResolvedValue(nextSettings);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.updateSettings({ enableAssistantStreaming: true })).resolves.toEqual(
      nextSettings,
    );
    expect(rpcClientMock.server.updateSettings).toHaveBeenCalledWith({
      enableAssistantStreaming: true,
    });
  });

  it("forwards document URL reads directly to the RPC client", async () => {
    const result = {
      sourceUrl: "https://example.com/report",
      resolvedUrl: "https://example.com/report.pdf",
      title: "Report",
      text: "Body",
    };
    rpcClientMock.server.readDocumentUrl.mockResolvedValue(result);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(
      api.server.readDocumentUrl({ url: "https://example.com/report" }),
    ).resolves.toEqual(result);
    expect(rpcClientMock.server.readDocumentUrl).toHaveBeenCalledWith({
      url: "https://example.com/report",
    });
  });
});
