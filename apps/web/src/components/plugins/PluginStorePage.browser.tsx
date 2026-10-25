import "../../index.css";
import type { PluginCatalog } from "@bigbud/contracts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { rpc, toast } = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn() }));
vi.mock("~/rpc/client", () => ({
  runRpc: (operation: (client: typeof rpc) => unknown) => operation(rpc),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: toast } }));
vi.mock("../standalone/StandaloneChatPageShell", () => ({
  StandaloneChatPageShell: ({ header, children }: { header: ReactNode; children: ReactNode }) => (
    <div style={{ height: 600 }} className="flex flex-col">
      {header}
      {children}
    </div>
  ),
}));
vi.mock("../layout/ContentPanelHeaderBar", () => ({
  ContentPanelHeaderBar: ({
    title,
    center,
    actions,
  }: {
    title: ReactNode;
    center: ReactNode;
    actions: ReactNode;
  }) => (
    <header>
      {title}
      {center}
      {actions}
    </header>
  ),
}));
vi.mock("./PluginCatalogRow", () => ({ PluginCatalogRow: () => <p>Example plugin</p> }));

import { PluginStorePage } from "./PluginStorePage";

const empty = { items: [], installed: [], sync: { status: "ready" } } as unknown as PluginCatalog;
const populated = {
  ...empty,
  items: [
    { id: "example", name: "Example", presentation: { displayName: "Example", category: "Tools" } },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let screen: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  rpc.mockReset();
  toast.mockClear();
});
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
});

describe("Plugin catalog initial loading", () => {
  it("shows the startup loader, resolves empty, and keeps search/refresh available", async () => {
    const request = deferred<PluginCatalog>();
    rpc.mockReturnValue(request.promise);
    screen = await render(<PluginStorePage />);
    await expect.element(screen.getByText("Loading plugins", { exact: true })).toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Refresh", exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole("searchbox", { name: "Search plugins" })).toBeVisible();
    expect(document.querySelectorAll(".animate-pulse-slow")).toHaveLength(1);
    request.resolve(empty);
    await expect.element(screen.getByText("No plugins found.")).toBeVisible();
    expect(document.querySelector(".animate-pulse-slow")).toBeNull();
  });

  it("keeps data during refresh and after refresh failure", async () => {
    rpc.mockResolvedValueOnce(populated);
    screen = await render(<PluginStorePage />);
    await expect.element(screen.getByText("Example plugin")).toBeVisible();
    const refresh = deferred<PluginCatalog>();
    rpc.mockReturnValueOnce(refresh.promise);
    await screen.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.element(screen.getByText("Example plugin")).toBeVisible();
    expect(document.querySelector(".animate-pulse-slow")).toBeNull();
    refresh.reject(new Error("offline"));
    await expect
      .element(screen.getByRole("button", { name: "Refresh", exact: true }))
      .toBeEnabled();
    await expect.element(screen.getByText("Example plugin")).toBeVisible();
  });

  it("ends loading on initial error and allows retry through Refresh", async () => {
    rpc.mockRejectedValueOnce(new Error("offline"));
    screen = await render(<PluginStorePage />);
    await expect.element(screen.getByRole("alert")).toHaveTextContent("offline");
    expect(document.querySelector(".animate-pulse-slow")).toBeNull();
    rpc.mockResolvedValueOnce(empty);
    await screen.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.element(screen.getByText("No plugins found.")).toBeVisible();
  });

  it("ignores an older initial response after a manual refresh wins", async () => {
    const initial = deferred<PluginCatalog>();
    rpc.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(populated);
    screen = await render(<PluginStorePage />);
    await screen.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.element(screen.getByText("Example plugin")).toBeVisible();
    initial.resolve(empty);
    await expect.element(screen.getByText("Example plugin")).toBeVisible();
  });
});
