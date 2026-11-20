import type { DesktopTailscaleRemoteAccessStatus } from "@bigbud/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));

import { MobileRemoteTailscaleBackendRow } from "./MobileRemoteControlSettingsSection.tailscale";

const conflicted: DesktopTailscaleRemoteAccessStatus = {
  installed: true,
  running: true,
  online: true,
  serving: false,
  remoteBaseUrl: "https://desk.tail1.ts.net",
  httpsPort: 443,
  conflict: { loopbackPort: 3773, bigbudOwnerLabel: "bigbud", canTakeOver: true },
  error: 'Tailscale Serve\'s HTTPS port 443 already forwards "/" to 127.0.0.1:3773.',
};
const serving: DesktopTailscaleRemoteAccessStatus = {
  ...conflicted,
  serving: true,
  conflict: null,
  error: null,
};

const takeOver = vi.fn<() => Promise<DesktopTailscaleRemoteAccessStatus>>();
const enable = vi.fn<() => Promise<DesktopTailscaleRemoteAccessStatus>>();
const clients: QueryClient[] = [];

async function mount(status: DesktopTailscaleRemoteAccessStatus, onUrl = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const screen = await render(
    <QueryClientProvider client={client}>
      <MobileRemoteTailscaleBackendRow
        status={status}
        isLoading={false}
        onBackendBaseUrlChange={onUrl}
      />
    </QueryClientProvider>,
  );
  return { screen, onUrl };
}

beforeEach(() => {
  mocks.confirm.mockReset();
  takeOver.mockReset().mockResolvedValue(serving);
  enable.mockReset().mockResolvedValue(conflicted);
  vi.stubGlobal("desktopBridge", {
    enableTailscaleRemoteAccess: enable,
    disableTailscaleRemoteAccess: vi.fn(),
    takeOverTailscaleRemoteAccess: takeOver,
  });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

describe("MobileRemoteTailscaleBackendRow take over", () => {
  it("offers Take over for another bigbud and acts only after confirmation", async () => {
    const { screen, onUrl } = await mount(conflicted);
    await expect.element(screen.getByTestId("tailscale-take-over")).toBeVisible();
    mocks.confirm.mockResolvedValueOnce(false);
    await screen.getByRole("button", { name: "Take over" }).click();
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(takeOver).not.toHaveBeenCalled();

    mocks.confirm.mockResolvedValueOnce(true);
    await screen.getByRole("button", { name: "Take over" }).click();
    await vi.waitFor(() => expect(takeOver).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onUrl).toHaveBeenCalledWith("https://desk.tail1.ts.net"));
  });

  it("never offers Take over for a non-bigbud service", async () => {
    const { screen } = await mount({
      ...conflicted,
      conflict: { loopbackPort: 3000, bigbudOwnerLabel: null, canTakeOver: false },
    });
    await expect.element(screen.getByTestId("tailscale-doctor")).toBeVisible();
    expect(screen.getByTestId("tailscale-take-over").query()).toBeNull();
    expect(screen.getByRole("button", { name: "Take over" }).query()).toBeNull();
  });

  it("renders a refused enable as status instead of adopting the tailnet URL", async () => {
    const { screen, onUrl } = await mount(conflicted);
    await screen.getByRole("button", { name: "Enable Tailscale Serve" }).click();
    await vi.waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
    await expect.element(screen.getByTestId("tailscale-take-over")).toBeVisible();
    expect(onUrl).not.toHaveBeenCalled();
  });
});
