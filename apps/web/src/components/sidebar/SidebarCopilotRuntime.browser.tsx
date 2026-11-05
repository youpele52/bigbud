import "../../index.css";
import type { ReactNode } from "react";
import type {
  CopilotRuntimeInput,
  CopilotRuntimeState,
} from "@bigbud/contracts/server/copilotRuntime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { SidebarCopilotRuntime } from "./SidebarCopilotRuntime";
import { CopilotRuntimeSettings } from "../settings/CopilotRuntimeSettings";
import { DownloadProgress } from "../common/DownloadProgress";
import { copilotRuntimeQueryKey, requestCopilotSetup } from "../../hooks/useCopilotRuntime";
import { ensureCopilotRuntimeForChat } from "../chat/provider/copilotRuntime.guard";

const mocks = vi.hoisted(() => ({
  request: vi.fn<(input: CopilotRuntimeInput) => Promise<CopilotRuntimeState>>(),
  navigate: vi.fn(),
}));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: { copilotRuntime: mocks.request, refreshProviders: async () => undefined },
  }),
  readNativeApi: () => ({ server: { copilotRuntime: mocks.request } }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
let state: CopilotRuntimeState;
let identity = 0;
const clients: QueryClient[] = [];
beforeEach(() => {
  identity = 0;
  state = {
    available: false,
    source: "missing",
    path: null,
    version: null,
    installedSizeBytes: null,
    managed: [],
    activeLeases: 0,
    onboarding: true,
    pinnedVersion: "1.0.103",
    job: null,
    error: null,
    diagnostic: null,
  };
  mocks.request.mockReset();
  mocks.navigate.mockReset();
  mocks.request.mockImplementation(async (input) => {
    if (input.action === "acknowledge") state = { ...state, onboarding: false };
    if (input.action === "install" || input.action === "update")
      state = {
        ...state,
        onboarding: false,
        job: {
          id: `job-${++identity}`,
          operation: "install",
          phase: "downloading",
          version: "1.0.103",
          transferredBytes: 30,
          totalBytes: 120,
          error: null,
        },
      };
    if (input.action === "cancel")
      state = { ...state, job: state.job ? { ...state.job, phase: "cancelled" } : null };
    if (input.action === "uninstall") state = { ...state, managed: [], onboarding: false };
    return state;
  });
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});
async function mount(children: ReactNode = <SidebarCopilotRuntime />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const screen = await render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
  return { screen, client };
}

describe("Copilot runtime setup and downloads", () => {
  it.each(["configured", "managed", "bundled-native", "existing", "sdk"] as const)(
    "never offers install onboarding for available %s",
    async (source) => {
      state = { ...state, available: true, source };
      const { screen } = await mount();
      try {
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith({ action: "status" }));
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
        expect(mocks.request.mock.calls.some(([input]) => input.action === "install")).toBe(false);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("persists Set up later and does not start a download when reopened", async () => {
    const { screen } = await mount();
    await expect
      .element(page.getByRole("dialog", { name: "Do you use GitHub Copilot?" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Set up later", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await screen.unmount();
    const reopened = await mount();
    try {
      await vi.waitFor(() => expect(state.onboarding).toBe(false));
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(mocks.request.mock.calls.some(([input]) => input.action === "install")).toBe(false);
    } finally {
      await reopened.screen.unmount();
    }
  });

  it("Use existing installation acknowledges then opens the existing provider settings", async () => {
    const { screen } = await mount();
    try {
      await page.getByRole("button", { name: "Use existing installation", exact: true }).click();
      await vi.waitFor(() =>
        expect(mocks.navigate).toHaveBeenCalledWith({
          href: expect.stringContaining("/settings/providers?"),
        }),
      );
      expect(state.onboarding).toBe(false);
      expect(mocks.request.mock.calls.some(([input]) => input.action === "install")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it.each(["close", "escape"])("remembers %s dismissal without installing", async (method) => {
    const { screen } = await mount();
    try {
      await expect.element(page.getByRole("dialog")).toBeVisible();
      if (method === "close")
        await page.getByRole("button", { name: "Close", exact: true }).click();
      else await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(state.onboarding).toBe(false);
      expect(mocks.request.mock.calls.some(([input]) => input.action === "install")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("does not trap the app when acknowledgement fails, and retries saving after reconnect", async () => {
    const implementation = mocks.request.getMockImplementation()!;
    let failed = false;
    mocks.request.mockImplementation(async (input) => {
      if (input.action === "acknowledge" && !failed) {
        failed = true;
        throw new Error("offline");
      }
      return implementation(input);
    });
    const { screen, client } = await mount();
    try {
      await page.getByRole("button", { name: "Set up later", exact: true }).click();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Could not remember");
      await client.invalidateQueries({ queryKey: copilotRuntimeQueryKey });
      await vi.waitFor(() => expect(state.onboarding).toBe(false));
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(mocks.request.mock.calls.some(([input]) => input.action === "install")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("wires install/cancel/retry and keeps the app download independent in the shared position", async () => {
    const { screen } = await mount(
      <>
        <DownloadProgress label="Downloading update" percent={53} />
        <SidebarCopilotRuntime />
      </>,
    );
    try {
      await page.getByRole("button", { name: "Install Copilot", exact: true }).click();
      await expect
        .element(page.getByRole("progressbar", { name: "Downloading Copilot" }))
        .toHaveAttribute("aria-valuenow", "25");
      await expect
        .element(page.getByRole("progressbar", { name: "Downloading update" }))
        .toHaveAttribute("aria-valuenow", "53");
      const id = state.job?.id;
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(mocks.request).toHaveBeenCalledWith({ action: "cancel", jobId: id });
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      expect(state.job?.id).not.toBe(id);
      await expect
        .element(page.getByRole("progressbar", { name: "Downloading update" }))
        .toHaveAttribute("aria-valuenow", "53");
    } finally {
      await screen.unmount();
    }
  });

  it("settings distinguish external ownership and block managed removal while leased", async () => {
    const clear = vi.fn();
    state = {
      ...state,
      available: true,
      source: "configured",
      path: "/external/copilot",
      onboarding: false,
    };
    const { screen, client } = await mount(
      <CopilotRuntimeSettings customPath="/external/copilot" onClearPath={clear} />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Install managed copy" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Uninstall managed runtime" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Clear custom path" }).click();
      expect(clear).toHaveBeenCalledOnce();
      state = {
        ...state,
        activeLeases: 1,
        managed: [
          {
            path: "/managed/package/copilot",
            directory: "/managed",
            version: "1.0.103",
            target: "darwin-arm64",
            sizeBytes: 181811714,
          },
        ],
      };
      client.setQueryData(copilotRuntimeQueryKey, state);
      await expect
        .element(page.getByRole("button", { name: "Uninstall managed runtime" }))
        .toBeDisabled();
      state = { ...state, activeLeases: 0 };
      client.setQueryData(copilotRuntimeQueryKey, state);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      await page.getByRole("button", { name: "Uninstall managed runtime" }).click();
      expect(mocks.request).toHaveBeenCalledWith({ action: "uninstall" });
      expect(state.onboarding).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("chat requests setup after dismissal without changing the model or dispatching a turn", async () => {
    state = { ...state, onboarding: false };
    const { screen } = await mount();
    try {
      await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled());
      expect(await ensureCopilotRuntimeForChat()).toBe(false);
      await expect
        .element(page.getByRole("dialog", { name: "Do you use GitHub Copilot?" }))
        .toBeVisible();
      expect(mocks.request.mock.calls.every(([input]) => input.action === "status")).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("a manual setup request for an existing runtime opens settings rather than an install prompt", async () => {
    state = { ...state, available: true, source: "existing", onboarding: false };
    const { screen } = await mount();
    try {
      await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled());
      requestCopilotSetup();
      await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(await ensureCopilotRuntimeForChat()).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("does not suggest installation for an existing executable with a version/auth diagnostic", async () => {
    state = {
      ...state,
      source: "configured",
      available: false,
      onboarding: false,
      path: "/existing/copilot",
      diagnostic: "Version probe failed",
    };
    const { screen } = await mount();
    try {
      await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled());
      requestCopilotSetup();
      await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
