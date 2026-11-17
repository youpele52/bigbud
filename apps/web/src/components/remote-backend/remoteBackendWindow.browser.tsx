import "~/index.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const relay = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ server: { listRemoteBackendRelayProfiles: relay.list } }),
}));

import { __resetBackendScopeForTests, setBackendScope } from "../../rpc/backendScope.state";
import { SidebarRemoteBackends } from "../sidebar/SidebarRemoteBackends";
import { SidebarProvider } from "../ui/sidebar";
import { BackendScopeGate } from "./BackendScopeGate";
import { RemoteBackendWindowStatus } from "./RemoteBackendWindowStatus";

const identity = {
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
};

afterEach(() => {
  __resetBackendScopeForTests();
  relay.list.mockReset();
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  document.body.innerHTML = "";
});

describe("remote backend window", () => {
  it("keeps the app unmounted until bound and swaps to update guidance on refusal", async () => {
    setBackendScope({ kind: "binding", profileId: "vps-1" });
    const screen = await render(
      <BackendScopeGate>
        <p>remote app</p>
      </BackendScopeGate>,
    );
    await expect.element(page.getByText("Connecting to remote backend")).toBeVisible();
    expect(screen.container.textContent).not.toContain("remote app");

    setBackendScope(
      {
        kind: "bound",
        profileId: "vps-1",
        label: "Build VPS",
        http: { origin: "http://127.0.0.1:4100", headers: {} },
      },
      { api: {} as never, rpcClient: {} as never },
    );
    await expect.element(page.getByText("remote app")).toBeVisible();

    setBackendScope({ kind: "refused", profileId: "vps-1", refusal: "unsupported-revision" });
    await expect.element(page.getByText("Update required")).toBeVisible();
    await expect.element(page.getByText(/Update both to the same bigbud release/)).toBeVisible();
    expect(screen.container.textContent).not.toContain("remote app");
    expect(document.querySelector('[data-status="error"]')).not.toBeNull();
  });

  it("offers retry for a typed unavailable relay", async () => {
    const onRetry = vi.fn();
    await render(
      <RemoteBackendWindowStatus
        state={{ kind: "unavailable", profileId: "vps-1", reason: "setup-required" }}
        onRetry={onRetry}
      />,
    );
    await expect.element(page.getByText("Remote backends unavailable")).toBeVisible();
    expect(document.querySelector('[data-status="warning"]')).not.toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("sidebar Open remote backend entry", () => {
  function renderEntry() {
    return render(
      <SidebarProvider defaultOpen>
        <SidebarRemoteBackends />
      </SidebarProvider>,
    );
  }

  it("is hidden when the relay reports no profiles", async () => {
    window.desktopBridge = { openRemoteBackendWindow: vi.fn() } as never;
    relay.list.mockResolvedValue({ availability: "setup-required", profiles: [] });
    const screen = await renderEntry();
    await vi.waitFor(() => expect(relay.list).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.container.textContent).not.toContain("Open remote backend");
  });

  it("opens one window per profile and shows typed unavailable when the relay empties", async () => {
    const open = vi.fn(async () => ({ status: "opened" as const }));
    window.desktopBridge = { openRemoteBackendWindow: open } as never;
    relay.list.mockResolvedValueOnce({
      availability: "available",
      profiles: [{ profileId: "vps-1", label: "Build VPS", identity }],
    });
    await renderEntry();
    relay.list.mockResolvedValueOnce({
      availability: "available",
      profiles: [{ profileId: "vps-1", label: "Build VPS", identity }],
    });
    await userEvent.click(page.getByText("Open remote backend"));
    await userEvent.click(page.getByText("Build VPS"));
    expect(open).toHaveBeenCalledWith("vps-1");

    relay.list.mockResolvedValue({ availability: "setup-required", profiles: [] });
    await userEvent.click(page.getByText("Open remote backend"));
    await expect
      .element(page.getByText("Remote backends unavailable: setup required"))
      .toBeVisible();
  });
});
