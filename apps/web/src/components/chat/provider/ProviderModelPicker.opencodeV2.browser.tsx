import "../../../index.css";
import type { ServerProvider } from "@bigbud/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { getCustomModelOptionsByProvider } from "../../../models/provider";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { RECENTLY_USED_MODELS_STORAGE_KEY } from "../../../models/recentlyUsedModels";

function snapshotFixture(): ServerProvider {
  return {
    provider: "opencodeV2",
    enabled: true,
    installed: true,
    version: "2.0.26",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-30T00:00:00.000Z",
    models: [
      {
        slug: "synthetic",
        name: "Synthetic V2 model",
        subProviderID: "synthetic",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
    slashCommands: [],
    skills: [],
    supportsLocalRuntimeRemoteWorkspace: false,
  };
}

it("exposes a separate unavailable V2 entry without selecting a model", async () => {
  const snapshot = { ...snapshotFixture(), installed: false, models: [] };
  const options = getCustomModelOptionsByProvider(
    DEFAULT_UNIFIED_SETTINGS,
    [snapshot],
    "codex",
    "gpt-5.4",
  );
  const onChange = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ProviderModelPicker
      provider="codex"
      model="gpt-5.4"
      lockedProvider={null}
      providers={[snapshot]}
      modelOptionsByProvider={options}
      onProviderModelChange={onChange}
    />,
    { container: host },
  );
  try {
    await page.getByRole("button").click();
    await expect.element(page.getByRole("menuitem", { name: /OpenCode v2/i })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
    host.remove();
  }
});

it("selects a configured native V2 model/subprovider without a hidden development flag", async () => {
  const snapshot = {
    ...snapshotFixture(),
    auth: { status: "unknown" as const },
  };
  const options = getCustomModelOptionsByProvider(
    DEFAULT_UNIFIED_SETTINGS,
    [snapshot],
    "opencodeV2",
    "synthetic",
  );
  const change = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ProviderModelPicker
      provider="opencodeV2"
      model="synthetic"
      lockedProvider="opencodeV2"
      providers={[snapshot]}
      modelOptionsByProvider={options}
      onProviderModelChange={change}
    />,
    { container: host },
  );
  try {
    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: /Synthetic V2 model/ }).click();
    expect(change).toHaveBeenCalledWith("opencodeV2", "synthetic", "synthetic");
  } finally {
    await screen.unmount();
    host.remove();
  }
});

it("selects a different native model without changing the bound V2 provider", async () => {
  const base = snapshotFixture();
  const snapshot = {
    ...base,
    models: [...base.models, { ...base.models[0]!, slug: "second", name: "Second V2 model" }],
  };
  const options = getCustomModelOptionsByProvider(
    DEFAULT_UNIFIED_SETTINGS,
    [snapshot],
    "opencodeV2",
    "synthetic",
  );
  const change = vi.fn();
  const screen = await render(
    <ProviderModelPicker
      provider="opencodeV2"
      model="synthetic"
      lockedProvider="opencodeV2"
      providers={[snapshot]}
      modelOptionsByProvider={options}
      onProviderModelChange={change}
    />,
  );
  try {
    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: /Second V2 model/ }).click();
    expect(change).toHaveBeenCalledWith("opencodeV2", "second", "synthetic");
  } finally {
    await screen.unmount();
  }
});

it("browses grouped full-catalog models with setup guidance, search and exact-subprovider recent selection", async () => {
  const base = snapshotFixture();
  const snapshot: ServerProvider = {
    ...base,
    status: "warning",
    auth: { status: "unknown" },
    message:
      "Connect/configure the exact subprovider in the dedicated V2 profile, then refresh; accounts are not verified by browsing.",
    models: [
      {
        ...base.models[0]!,
        slug: "same",
        name: "Friendly Coder",
        group: "Anthropic",
        subProviderID: "anthropic",
        availability: "requires-setup",
      },
      {
        ...base.models[0]!,
        slug: "same",
        name: "Friendly Coder",
        group: "OpenAI",
        subProviderID: "openai",
        availability: "requires-setup",
      },
    ],
  };
  const previous = localStorage.getItem(RECENTLY_USED_MODELS_STORAGE_KEY);
  localStorage.setItem(
    RECENTLY_USED_MODELS_STORAGE_KEY,
    JSON.stringify([
      {
        provider: "opencodeV2",
        model: "same",
        subProviderID: "openai",
        lastUsedAt: "2026-10-09T00:00:00Z",
      },
    ]),
  );
  const change = vi.fn();
  const screen = await render(
    <ProviderModelPicker
      provider="opencodeV2"
      model="same::anthropic"
      lockedProvider="opencodeV2"
      enableRecentlyUsed
      providers={[snapshot]}
      modelOptionsByProvider={getCustomModelOptionsByProvider(
        DEFAULT_UNIFIED_SETTINGS,
        [snapshot],
        "opencodeV2",
        "same",
      )}
      onProviderModelChange={change}
    />,
  );
  try {
    await page.getByRole("button").click();
    await expect.element(page.getByText("Recently used", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Anthropic", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("OpenAI", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitemradio").first())
      .toHaveTextContent("Provider not connected");
    await page.getByPlaceholder("Search models").fill("OpenAI");
    await expect.element(page.getByText("Recently used", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("Anthropic", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole("menuitemradio")).toHaveTextContent("Friendly Coder");
    await page.getByPlaceholder("Search models").fill("friendly");
    expect(await page.getByRole("menuitemradio").all()).toHaveLength(2);
    await page.getByPlaceholder("Search models").fill("");
    await page.getByRole("menuitemradio").first().click();
    expect(change).toHaveBeenCalledWith("opencodeV2", "same", "openai");
  } finally {
    await screen.unmount();
    if (previous === null) localStorage.removeItem(RECENTLY_USED_MODELS_STORAGE_KEY);
    else localStorage.setItem(RECENTLY_USED_MODELS_STORAGE_KEY, previous);
  }
});
