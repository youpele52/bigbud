import "../../index.css";

import type { PluginCatalogItem, PluginInstallation } from "@bigbud/contracts";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { rpcClientSpy, rpcState, toastAddSpy } = vi.hoisted(() => {
  const state = {
    handler: (_method: string, _input: unknown): Promise<unknown> => Promise.resolve(undefined),
  };
  return {
    rpcState: state,
    rpcClientSpy: vi.fn((method: string, input: unknown) => state.handler(method, input)),
    toastAddSpy: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useParams: () => ({ pluginId: "openai-public:example" }),
}));
vi.mock("../layout/ContentPanelHeaderBar", () => ({
  ContentPanelHeaderBar: ({ title }: { title: ReactNode }) => <header>{title}</header>,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: toastAddSpy } }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/rpc/client", () => ({
  runRpc: (operation: (client: typeof rpcClientSpy) => Promise<unknown>) => operation(rpcClientSpy),
}));
vi.mock("~/rpc/wsHttpOrigin", () => ({ resolveWsHttpOrigin: () => "http://127.0.0.1:3774" }));

import { PluginDetailsPage } from "./PluginDetailsPage";

const item: PluginCatalogItem = {
  id: "openai-public:example",
  name: "example",
  commit: "revision-b",
  sourcePath: "./plugins/example",
  presentation: { displayName: "Example", assets: {} },
  components: [{ kind: "skill", name: "example", path: "./skills" }],
  compatibility: "compatible",
};
const installation: PluginInstallation = {
  pluginId: item.id,
  revision: "revision-a",
  installedAt: "2026-08-09T00:00:00Z",
};

describe("PluginDetailsPage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rpcClientSpy.mockClear();
    toastAddSpy.mockClear();
    vi.restoreAllMocks();
  });

  it("renders a retryable error and toast when plugin loading fails", async () => {
    rpcState.handler = () => Promise.reject(new Error("catalog offline"));
    const host = document.createElement("div");
    document.body.append(host);
    await render(<PluginDetailsPage />, { container: host });

    await expect
      .poll(() => host.querySelector('[role="alert"]')?.textContent)
      .toContain("catalog offline");
    expect(host.textContent).not.toContain("Loading plugin…");
    expect(toastAddSpy).toHaveBeenCalledWith({
      type: "error",
      title: "Could not load plugin",
      description: "catalog offline",
    });
  });

  it("updates without showing uninstall confirmation", async () => {
    rpcState.handler = (method) =>
      method === "plugins.get"
        ? Promise.resolve({ item, installation })
        : Promise.resolve({ installed: [{ ...installation, revision: item.commit }] });
    const confirmSpy = vi.spyOn(window, "confirm");
    const host = document.createElement("div");
    document.body.append(host);
    await render(<PluginDetailsPage />, { container: host });
    await expect.poll(() => host.textContent).toContain("Update plugin");

    const updateButton = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Update plugin"),
    );
    updateButton?.click();
    await expect
      .poll(() => rpcClientSpy.mock.calls.some(([method]) => method === "plugins.update"))
      .toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("reports mutation failures and re-enables the action", async () => {
    rpcState.handler = (method) =>
      method === "plugins.get"
        ? Promise.resolve({ item, installation })
        : Promise.reject(new Error("update failed"));
    const host = document.createElement("div");
    document.body.append(host);
    await render(<PluginDetailsPage />, { container: host });
    await expect.poll(() => host.textContent).toContain("Update plugin");

    const updateButton = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Update plugin"),
    );
    updateButton?.click();
    await expect.poll(() => toastAddSpy.mock.calls.length).toBe(1);
    expect(toastAddSpy).toHaveBeenCalledWith({
      type: "error",
      title: "Could not update plugin",
      description: "update failed",
    });
    await expect.poll(() => updateButton?.disabled).toBe(false);
  });
});
