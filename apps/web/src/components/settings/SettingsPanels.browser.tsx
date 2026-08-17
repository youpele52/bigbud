import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  type DesktopBridge,
  type NativeApi,
  type ServerConfig,
} from "@bigbud/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetNativeApiForTests } from "../../rpc/nativeApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { AboutSettingsPanel, AiSettingsPanel, ProvidersSettingsPanel } from "./SettingsPanels";

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    storage: {
      notesDir: "/repo/project/.t3/notes",
      kanbanDir: "/repo/project/.t3/kanban",
    },
    keybindingsConfigPath: "/repo/project/.bigbud-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        enabled: true,
        installed: true,
        version: "0.116.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00.000Z",
        models: [
          {
            slug: "gpt-5.4-mini",
            name: "GPT-5.4 Mini",
            isCustom: false,
            capabilities: {
              reasoningEffortLevels: [],
              supportsFastMode: true,
              supportsThinkingToggle: false,
              contextWindowOptions: [],
              promptInjectedEffortLevels: [],
            },
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ],
    discovery: {
      agents: [],
      skills: [],
    },
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function renderAiSettingsPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppAtomRegistryProvider>
        <AiSettingsPanel />
      </AppAtomRegistryProvider>
    </QueryClientProvider>,
  );
}

describe("AboutSettingsPanel observability", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    delete window.desktopBridge;
  });

  it("shows diagnostics inside About with a single logs-folder action", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <AboutSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByRole("heading", { name: "Application" })).toBeInTheDocument();
    await expect.element(page.getByRole("img", { name: "bigbud" })).toBeInTheDocument();
    await expect.element(page.getByRole("heading", { name: "Links" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Website" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "GitHub" })).toBeInTheDocument();
    await expect.element(page.getByText("Diagnostics")).toBeInTheDocument();
    await expect.element(page.getByText("Open logs folder")).toBeInTheDocument();
    await expect.element(page.getByText("Restart bigbud")).not.toBeInTheDocument();
    await expect
      .element(page.getByText("/repo/project/.t3/logs", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Local trace file. OTLP exporting traces to http://localhost:4318/v1/traces.",
        ),
      )
      .toBeInTheDocument();
  });

  it("shows Restart bigbud before diagnostics on desktop", async () => {
    const restartApplication = vi.fn().mockResolvedValue(undefined);
    window.desktopBridge = { restartApplication } as unknown as DesktopBridge;
    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <AboutSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const restartButton = page.getByRole("button", { name: "Restart bigbud" });
    await expect.element(restartButton).toBeInTheDocument();
    await restartButton.click();
    expect(restartApplication).toHaveBeenCalledOnce();
  });

  it("opens the logs folder in the preferred editor", async () => {
    const openInEditor = vi.fn<NativeApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
    window.nativeApi = {
      shell: {
        openInEditor,
      },
    } as unknown as NativeApi;

    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <AboutSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const openLogsButton = page.getByText("Open logs folder");
    await openLogsButton.click();

    expect(openInEditor).toHaveBeenCalledWith("/repo/project/.t3/logs", "cursor");
  });
});

describe("AiSettingsPanel defaults", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    delete window.desktopBridge;
  });

  it("renders stream replies and stream thinking enabled by default", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    await renderAiSettingsPanel();

    await expect
      .element(page.getByLabelText("Stream replies"))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByLabelText("Stream thinking"))
      .toHaveAttribute("aria-checked", "true");
  });

  it("renders, updates, and resets the default agent browser preference", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    window.nativeApi = {
      server: { updateSettings },
    } as unknown as NativeApi;
    setServerConfigSnapshot(createBaseServerConfig());

    await renderAiSettingsPanel();

    const trigger = page.getByLabelText("Default agent browser", { exact: true });
    await expect.element(trigger).toHaveTextContent("bigbud browser — Recommended");
    await expect
      .element(
        page.getByText(
          "Explicit prompts override this preference. System-browser interaction requires the desktop app, full-access mode, and enabled computer use.",
        ),
      )
      .toBeInTheDocument();

    await trigger.click();
    await page.getByText("System default browser", { exact: true }).click();

    expect(updateSettings).toHaveBeenCalledWith({ agentBrowserPreference: "system" });
    await expect.element(trigger).toHaveTextContent("System default browser");

    await page.getByLabelText("Reset default agent browser to default").click();
    expect(updateSettings).toHaveBeenLastCalledWith({ agentBrowserPreference: "bigbud" });
    await expect.element(trigger).toHaveTextContent("bigbud browser — Recommended");
  });

  it("places floating assistant settings directly after browser settings", async () => {
    window.desktopBridge = {
      getFloatingAssistantEnabled: vi.fn().mockResolvedValue(true),
      setFloatingAssistantEnabled: vi.fn().mockResolvedValue(true),
    } as unknown as DesktopBridge;
    setServerConfigSnapshot(createBaseServerConfig());

    await renderAiSettingsPanel();

    const sectionTitles = Array.from(document.querySelectorAll("h2"), (heading) =>
      heading.textContent?.trim(),
    );
    expect(sectionTitles.indexOf("Floating assistant")).toBe(sectionTitles.indexOf("Browser") + 1);
    await expect.element(page.getByLabelText("Enable floating assistant")).toBeInTheDocument();
  });
});

describe("ProvidersSettingsPanel route expansion", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    setServerConfigSnapshot(createBaseServerConfig());
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
  });

  it("opens exactly the provider cards named by a direct route search", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await render(
      <QueryClientProvider client={queryClient}>
        <AppAtomRegistryProvider>
          <ProvidersSettingsPanel expandedProviders={["opencode", "kilocode"]} />
        </AppAtomRegistryProvider>
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(document.getElementById("provider-install-opencode-binary-path")).not.toBeNull();
      expect(document.getElementById("provider-install-kilocode-binary-path")).not.toBeNull();
      expect(document.getElementById("provider-install-codex-binary-path")).toBeNull();
    });
  });

  it("applies affected providers when preserved search is restored by history navigation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <AppAtomRegistryProvider>
          <ProvidersSettingsPanel expandedProviders={[]} />
        </AppAtomRegistryProvider>
      </QueryClientProvider>,
    );

    try {
      await screen.rerender(
        <QueryClientProvider client={queryClient}>
          <AppAtomRegistryProvider>
            <ProvidersSettingsPanel expandedProviders={["opencode"]} />
          </AppAtomRegistryProvider>
        </QueryClientProvider>,
      );

      await vi.waitFor(() => {
        expect(document.getElementById("provider-install-opencode-binary-path")).not.toBeNull();
        expect(document.getElementById("provider-install-kilocode-binary-path")).toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });
});
