import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { OPENCODE_RETAINED_HISTORY_ADVISORY } from "@bigbud/shared/opencodeAdvisory";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProviderCard } from "./ProviderCard";
import { buildProviderCards } from "./ProvidersSettingsSection.logic";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { getOpencodeV2ThreadToolsSetup: mocks.get } }),
}));
afterEach(() => mocks.get.mockReset());
const noop = () => {};
function props(patch: Partial<ServerProvider> = {}, isOpen = false) {
  const live: ServerProvider = {
    provider: "opencodeV2",
    enabled: true,
    installed: true,
    version: "2.0.28",
    status: "warning",
    auth: { status: "authenticated", label: "Anthropic, OpenAI" },
    checkedAt: "2026-10-14T00:00:00.000Z",
    initialProbeComplete: true,
    message: `Connected to your native OpenCode service. ${OPENCODE_RETAINED_HISTORY_ADVISORY}`,
    models: [],
    slashCommands: [],
    skills: [],
    ...patch,
  };
  const card = buildProviderCards({
    serverProviders: [live],
    settings: DEFAULT_UNIFIED_SETTINGS,
  }).find((c) => c.provider === "opencodeV2")!;
  return {
    card,
    isOpen,
    codexHomePath: "",
    customModelInput: "",
    customModelError: null,
    modelListRef: { current: null },
    onToggleOpen: noop,
    onOpenChange: noop,
    onResetProvider: noop,
    onToggleEnabled: noop,
    onBinaryPathChange: noop,
    onConfigPathChange: noop,
    onOpenSetupGuide: noop,
    onHomePathChange: noop,
    onCustomModelInputChange: noop,
    onAddCustomModel: noop,
    onRemoveCustomModel: noop,
  };
}

it("matches other providers' muted headline when closed; accounts and history stay inside", async () => {
  const input = props();
  const screen = await render(<ProviderCard {...input} />);
  try {
    await expect
      .element(page.getByText("Authenticated", { exact: true }))
      .toHaveClass("text-muted-foreground");
    await expect
      .element(page.getByRole("button", { name: "Reset OpenCode provider settings to default" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(/Accounts:/)).not.toBeInTheDocument();
    await expect
      .element(page.getByText(OPENCODE_RETAINED_HISTORY_ADVISORY, { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText("Setup needs attention", { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Toggle OpenCode details" }))
      .toHaveAttribute("aria-expanded", "false");
    await screen.rerender(<ProviderCard {...input} isOpen />);
    await expect
      .element(page.getByText("Accounts: Anthropic, OpenAI", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText(OPENCODE_RETAINED_HISTORY_ADVISORY, { exact: true }))
      .not.toBeVisible();
    await page.getByText("Native history", { exact: true }).click();
    await expect
      .element(page.getByText(OPENCODE_RETAINED_HISTORY_ADVISORY, { exact: true }))
      .toBeVisible();
    expect(mocks.get).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it.each(["warning", "error"] as const)(
  "keeps authenticated accounts separate from real %s setup/connection problems",
  async (status) => {
    const input = props({
      status,
      message: `Native qualification required. ${OPENCODE_RETAINED_HISTORY_ADVISORY}`,
    });
    const screen = await render(<ProviderCard {...input} />);
    try {
      const label = status === "error" ? "Connection failed" : "Setup needs attention";
      await expect
        .element(page.getByText(label, { exact: true }))
        .toHaveClass(status === "error" ? "text-destructive" : "text-warning");
      await screen.rerender(<ProviderCard {...input} isOpen />);
      await expect
        .element(page.getByText("Native qualification required.", { exact: true }))
        .toBeVisible();
      await page.getByText("Thread tools & setup", { exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Retry setup" })).toBeDisabled();
      expect(mocks.get).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  },
);

it.each([
  { initialProbeComplete: false },
  { installed: false },
  { enabled: false },
  { auth: { status: "unknown" as const } },
  { auth: { status: "unauthenticated" as const } },
  {
    failure: {
      classification: "user-action-required" as const,
      reason: "authentication-required" as const,
    },
  },
])(
  "does not render green authentication for incomplete or rejected evidence: %j",
  async (patch) => {
    const screen = await render(<ProviderCard {...props(patch)} />);
    try {
      await expect
        .element(page.getByText("Authenticated", { exact: true }))
        .not.toBeInTheDocument();
      expect(document.body.querySelectorAll(".bg-success, p.text-success").length).toBe(0);
      expect(mocks.get).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  },
);

it("keeps essential trust scope visible and Advanced/Details passive and keyboard accessible", async () => {
  const input = props({}, true);
  const screen = await render(<ProviderCard {...input} />);
  try {
    await expect
      .element(page.getByText(/Native tools run as your user, not in a sandbox/))
      .toBeVisible();
    await expect
      .element(page.getByRole("switch", { name: "Allow native tools" }))
      .not.toBeChecked();
    await expect
      .element(
        page.getByRole("textbox", { name: "Connection file (optional)", includeHidden: true }),
      )
      .not.toBeVisible();
    await page.getByText("Connection settings", { exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Connection file (optional)" }))
      .toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(
        page.getByRole("textbox", { name: "Connection file (optional)", includeHidden: true }),
      )
      .not.toBeVisible();
    await page.getByText("What this allows", { exact: true }).click();
    await expect
      .element(page.getByText(/Revoking consent stops new bigbud requests/))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Show status", includeHidden: true }))
      .not.toBeVisible();
    await page.getByText("Thread tools & setup", { exact: true }).click();
    await page.getByText("Plugin configuration", { exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Plugin config directory (optional)" }))
      .toBeVisible();
    expect(mocks.get).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("labels a 10k model catalog honestly without mounting thousands of rows", async () => {
  const models = Array.from({ length: 10000 }, (_, index) => ({
    slug: `public-${index}`,
    name: `public model ${index}`,
    isCustom: false,
    capabilities: null,
    availability: "requires-setup" as const,
  }));
  const input = props({ models });
  const screen = await render(<ProviderCard {...input} />);
  try {
    expect(
      document.body.querySelectorAll("button[aria-label^='Details for public model']").length,
    ).toBe(0);
    await screen.rerender(<ProviderCard {...input} isOpen />);
    await expect.element(page.getByText(/Model catalog · 10,000 models/)).toBeVisible();
    await expect
      .element(page.getByText("10000 models available.", { exact: true }))
      .not.toBeInTheDocument();
    expect(
      document.body.querySelectorAll("button[aria-label^='Details for public model']").length,
    ).toBe(0);
    await page.getByText(/Model catalog · 10,000 models/).click();
    const mountedRows = document.body.querySelectorAll(
      "button[aria-label^='Details for public model']",
    ).length;
    expect(mountedRows).toBeGreaterThan(0);
    expect(mountedRows).toBeLessThan(30);
    await page.getByText(/Model catalog · 10,000 models/).click();
    await vi.waitFor(() =>
      expect(
        document.body.querySelectorAll("button[aria-label^='Details for public model']").length,
      ).toBe(0),
    );
    expect(input.card.models).toHaveLength(10000);
    expect(mocks.get).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("keeps reset available inside the expanded OpenCode settings only", async () => {
  const reset = vi.fn();
  const input = props();
  input.card.isDirty = true;
  const screen = await render(<ProviderCard {...input} onResetProvider={reset} />);
  try {
    await expect
      .element(page.getByRole("button", { name: "Reset OpenCode provider settings to default" }))
      .not.toBeInTheDocument();
    await screen.rerender(<ProviderCard {...input} isOpen onResetProvider={reset} />);
    await page.getByRole("button", { name: "Reset OpenCode provider settings to default" }).click();
    expect(reset).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
  }
});
