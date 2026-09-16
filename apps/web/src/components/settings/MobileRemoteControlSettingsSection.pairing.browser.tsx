import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ createPairing: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { createMobileRemotePairing: mocks.createPairing } }),
}));

import {
  useMobileRemotePairing,
  MOBILE_WEB_SELECTION_STORAGE_KEY,
} from "./MobileRemoteControlSettingsSection.pairing";
import {
  MOBILE_WEB_BASE_URL_STORAGE_KEY,
  syncTailscaleDerivedUrls,
} from "./MobileRemoteControlSettingsSection.status";
import { MOBILE_DEV_DISCOVERY_QUERY_KEY } from "./MobileRemoteControlSettingsSection.discovery";
import { MobileRemoteUrlSelection } from "./MobileRemoteControlSettingsSection.urlSelection";

function Harness() {
  const [backend, setBackend] = useState("http://localhost:3773");
  const pairing = useMobileRemotePairing(backend);
  const client = useQueryClient();
  return (
    <>
      <MobileRemoteUrlSelection
        selection={pairing.selection}
        onChange={pairing.updateSelection}
        liveUrl={pairing.liveUrl}
        isDiscovering={pairing.isDiscovering}
      />
      <p data-testid="mode">{pairing.selection.mode}</p>
      <p data-testid="backend">{backend}</p>
      <p data-testid="link">{pairing.pairingLink ?? "none"}</p>
      <p data-testid="error">{pairing.pairingError ?? "none"}</p>
      <button
        disabled={pairing.isPairing || !pairing.mobileBaseUrl}
        onClick={pairing.createPairing}
      >
        Pair
      </button>
      <button
        onClick={() => void client.invalidateQueries({ queryKey: MOBILE_DEV_DISCOVERY_QUERY_KEY })}
      >
        Discover
      </button>
      <button
        onClick={() =>
          syncTailscaleDerivedUrls({
            status: {
              installed: true,
              running: true,
              online: true,
              serving: true,
              remoteBaseUrl: "https://desktop.ts.net",
              error: null,
            },
            setBackendBaseUrl: setBackend,
          })
        }
      >
        Tailscale
      </button>
      <button onClick={() => setBackend("http://localhost:3774")}>Local backend</button>
    </>
  );
}

const clients: QueryClient[] = [];
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

let listenerUrl: string | null;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  listenerUrl = "http://localhost:5742";
  fetchMock = vi.fn(async () => Response.json({ url: listenerUrl }));
  vi.stubGlobal("fetch", fetchMock);
  mocks.createPairing
    .mockReset()
    .mockImplementation(async ({ baseUrl }) => ({ pairUrl: `${baseUrl}/mobile#pair` }));
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("mobile URL selection and pairing", () => {
  it("shows Local when unavailable and follows listener changes through polling", async () => {
    listenerUrl = null;
    const screen = await mount();
    await expect.element(screen.getByTestId("mode")).toHaveTextContent("local");
    await expect.element(screen.getByRole("status")).toHaveTextContent("unavailable");
    await expect.element(screen.getByRole("button", { name: "Pair", exact: true })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Local", exact: true })).toBeVisible();
    listenerUrl = "http://localhost:5743";
    await expect
      .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
      .toHaveValue(listenerUrl);
    await screen.getByRole("button", { name: "Pair", exact: true }).click();
    await expect.element(screen.getByTestId("link")).toHaveTextContent("5743/mobile#pair");
    listenerUrl = null;
    await screen.getByRole("button", { name: "Discover" }).click();
    await expect.element(screen.getByTestId("link")).toHaveTextContent("none");
    await expect.element(screen.getByRole("textbox", { name: "Mobile app URL" })).toHaveValue("");
    await expect.element(screen.getByRole("button", { name: "Pair", exact: true })).toBeDisabled();
  });

  it("refreshes discovery before pairing and uses the newly discovered port", async () => {
    const screen = await mount();
    await expect
      .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
      .toHaveValue(listenerUrl!);
    listenerUrl = "http://localhost:5744";
    const before = fetchMock.mock.calls.length;
    await screen.getByRole("button", { name: "Pair", exact: true }).click();
    await expect.element(screen.getByTestId("link")).toHaveTextContent("5744/mobile#pair");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    expect(mocks.createPairing).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: listenerUrl }),
    );
  });

  it("blocks pairing when the immediate discovery refresh finds no listener", async () => {
    const screen = await mount();
    await expect
      .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
      .toHaveValue(listenerUrl!);
    listenerUrl = null;
    await screen.getByRole("button", { name: "Pair", exact: true }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("unavailable");
    expect(mocks.createPairing).not.toHaveBeenCalled();
    await expect.element(screen.getByTestId("link")).toHaveTextContent("none");
  });

  it("preserves custom input across Tailscale updates, backend changes, and reload", async () => {
    const screen = await mount();
    await screen
      .getByRole("textbox", { name: "Mobile app URL" })
      .fill("http://localhost:5950/custom");
    await screen.getByRole("button", { name: "Tailscale", exact: true }).click();
    await expect.element(screen.getByTestId("backend")).toHaveTextContent("https://desktop.ts.net");
    await screen.getByRole("button", { name: "Local backend", exact: true }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
      .toHaveValue("http://localhost:5950/custom");
    expect(JSON.parse(localStorage.getItem(MOBILE_WEB_SELECTION_STORAGE_KEY)!)).toEqual({
      mode: "custom",
      customUrl: "http://localhost:5950/custom",
    });
    await screen.unmount();
    const restored = await mount();
    await expect.element(restored.getByTestId("mode")).toHaveTextContent("custom");
    await expect
      .element(restored.getByRole("textbox", { name: "Mobile app URL" }))
      .toHaveValue("http://localhost:5950/custom");
  });

  it("persists explicit Local and hosted choices while keeping the custom draft", async () => {
    localStorage.setItem(MOBILE_WEB_BASE_URL_STORAGE_KEY, "http://192.168.1.24:5850/companion");
    const screen = await mount();
    await expect.element(screen.getByTestId("mode")).toHaveTextContent("custom");
    await screen.getByRole("button", { name: "Local", exact: true }).click();
    await expect.element(screen.getByTestId("mode")).toHaveTextContent("local");
    expect(JSON.parse(localStorage.getItem(MOBILE_WEB_SELECTION_STORAGE_KEY)!)).toEqual({
      mode: "local",
      customUrl: "http://192.168.1.24:5850/companion",
    });
    await screen.getByRole("button", { name: "bigbud", exact: true }).click();
    await expect.element(screen.getByTestId("mode")).toHaveTextContent("hosted");
    await screen.getByRole("button", { name: "Custom", exact: true }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
      .toHaveValue("http://192.168.1.24:5850/companion");
  });

  it("polls only in Local mode and fetches immediately when Local is selected", async () => {
    localStorage.setItem(
      MOBILE_WEB_SELECTION_STORAGE_KEY,
      JSON.stringify({ mode: "hosted", customUrl: "https://custom.example" }),
    );
    const screen = await mount();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Select Local");
    expect(fetchMock).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Local", exact: true }).click();
    await expect.poll(() => fetchMock.mock.calls.length, { timeout: 1_000 }).toBeGreaterThan(0);
    await expect
      .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
      .toHaveValue(listenerUrl!);
    await screen.getByRole("button", { name: "Custom", exact: true }).click();
    const fetchCount = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(fetchMock).toHaveBeenCalledTimes(fetchCount);
    await expect.element(screen.getByRole("status")).toHaveTextContent("Select Local");
    listenerUrl = "http://localhost:5745";
    await screen.getByRole("button", { name: "Local", exact: true }).click();
    await expect
      .poll(() => fetchMock.mock.calls.length, { timeout: 1_000 })
      .toBeGreaterThan(fetchCount);
    await expect
      .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
      .toHaveValue(listenerUrl);
  });

  it("does not pair an old selection if it changes during the immediate refresh", async () => {
    const screen = await mount();
    await expect
      .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
      .toHaveValue(listenerUrl!);
    let resolveDiscovery!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDiscovery = resolve;
        }),
    );
    await screen.getByRole("button", { name: "Pair", exact: true }).click();
    await expect.poll(() => typeof resolveDiscovery).toBe("function");
    await screen.getByRole("textbox", { name: "Mobile app URL" }).fill("https://custom.example");
    resolveDiscovery(Response.json({ url: listenerUrl }));
    await expect.element(screen.getByRole("button", { name: "Pair", exact: true })).toBeEnabled();
    expect(mocks.createPairing).not.toHaveBeenCalled();
    await expect.element(screen.getByTestId("link")).toHaveTextContent("none");
  });

  it("keeps automatic Local selected when Tailscale becomes the backend", async () => {
    const screen = await mount();
    await screen.getByRole("button", { name: "Tailscale", exact: true }).click();
    await expect.element(screen.getByTestId("mode")).toHaveTextContent("local");
    await expect
      .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
      .toHaveValue(listenerUrl!);
    await screen.getByRole("button", { name: "Pair", exact: true }).click();
    await expect.poll(() => mocks.createPairing.mock.calls.length).toBe(1);
    expect(mocks.createPairing).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: listenerUrl, backendBaseUrl: "https://desktop.ts.net" }),
    );
  });

  it("keeps hosted pairing available without discovery and clears links on URL changes", async () => {
    localStorage.setItem(MOBILE_WEB_BASE_URL_STORAGE_KEY, "https://mobile.bigbud.app");
    listenerUrl = null;
    const screen = await mount();
    await screen.getByRole("button", { name: "Pair", exact: true }).click();
    await expect
      .element(screen.getByTestId("link"))
      .toHaveTextContent("https://mobile.bigbud.app/mobile#pair");
    await screen
      .getByRole("textbox", { name: "Mobile app URL" })
      .fill("https://custom.example/app");
    await expect.element(screen.getByTestId("link")).toHaveTextContent("none");
  });

  it.each(["selection", "listener", "backend"])(
    "rejects a late pairing response after a %s change",
    async (change) => {
      let resolvePairing!: (value: { pairUrl: string }) => void;
      mocks.createPairing.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePairing = resolve;
          }),
      );
      const screen = await mount();
      await expect
        .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
        .toHaveValue(listenerUrl!);
      await screen.getByRole("button", { name: "Pair", exact: true }).click();
      await expect.poll(() => mocks.createPairing.mock.calls.length).toBe(1);
      if (change === "selection") {
        await screen
          .getByRole("textbox", { name: "Mobile app URL" })
          .fill("https://custom.example");
      } else if (change === "backend") {
        await screen.getByRole("button", { name: "Local backend", exact: true }).click();
      } else {
        listenerUrl = null;
        await screen.getByRole("button", { name: "Discover" }).click();
        await expect.element(screen.getByRole("status")).toHaveTextContent("unavailable");
        // Even if the same listener returns, its old in-flight link must stay invalidated.
        listenerUrl = "http://localhost:5742";
        await screen.getByRole("button", { name: "Discover" }).click();
        await expect
          .element(screen.getByRole("textbox", { name: "Mobile app URL" }))
          .toHaveValue(listenerUrl);
      }
      resolvePairing({ pairUrl: "https://stale.example/mobile" });
      await expect.element(screen.getByRole("button", { name: "Pair", exact: true })).toBeEnabled();
      await expect.element(screen.getByTestId("link")).toHaveTextContent("none");
    },
  );
});
