import "../../../index.css";
import type { ServerProvider } from "@bigbud/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { getCustomModelOptionsByProvider } from "../../../models/provider";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { RECENTLY_USED_MODELS_STORAGE_KEY } from "../../../models/recentlyUsedModels";
import { opencodeV2SnapshotFixture } from "./ProviderModelPicker.opencodeV2.browser.fixtures";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  routesByPath: { "/settings/providers": {} } as Record<string, unknown>,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => mocks,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.routesByPath = { "/settings/providers": {} };
});

it("opens targeted setup for an unavailable V2 entry without selecting a model", async () => {
  const snapshot = { ...opencodeV2SnapshotFixture(), installed: false, models: [] };
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
    await page.getByRole("menuitem", { name: /Set up OpenCode/i }).click();
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      href: "/settings/providers?providers=%5B%22opencodeV2%22%5D",
    });
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
    host.remove();
  }
});

it("shows consent guidance and setup for an empty locked V2 picker without selecting a model", async () => {
  const message = "Native service trust consent required";
  const snapshot: ServerProvider = {
    ...opencodeV2SnapshotFixture(),
    status: "warning",
    auth: { status: "unknown" },
    models: [],
    message,
  };
  const change = vi.fn();
  const screen = await render(
    <ProviderModelPicker
      provider="opencodeV2"
      model="synthetic"
      lockedProvider="opencodeV2"
      providers={[snapshot]}
      modelOptionsByProvider={getCustomModelOptionsByProvider(
        DEFAULT_UNIFIED_SETTINGS,
        [snapshot],
        "codex",
        "gpt-5.4",
      )}
      onProviderModelChange={change}
    />,
  );
  try {
    await page.getByRole("button").click();
    await expect.element(page.getByRole("status")).toHaveTextContent(message);
    await page.getByRole("menuitem", { name: /Set up OpenCode/ }).click();
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      href: "/settings/providers?providers=%5B%22opencodeV2%22%5D",
    });
    expect(change).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("directs mobile users to desktop/web setup rather than navigating to a missing route", async () => {
  mocks.routesByPath = {};
  const snapshot: ServerProvider = {
    ...opencodeV2SnapshotFixture(),
    status: "warning",
    models: [],
  };
  const change = vi.fn();
  const screen = await render(
    <ProviderModelPicker
      provider="codex"
      model="gpt-5.4"
      lockedProvider={null}
      providers={[snapshot]}
      modelOptionsByProvider={getCustomModelOptionsByProvider(
        DEFAULT_UNIFIED_SETTINGS,
        [snapshot],
        "codex",
        "gpt-5.4",
      )}
      onProviderModelChange={change}
    />,
  );
  try {
    await page.getByRole("button").click();
    await expect
      .element(page.getByText(/Review OpenCode setup and native service trust/))
      .toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: /Set up OpenCode/ }))
      .not.toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("selects a configured native V2 model/subprovider without a hidden development flag", async () => {
  const snapshot = {
    ...opencodeV2SnapshotFixture(),
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
  const base = opencodeV2SnapshotFixture();
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
  const base = opencodeV2SnapshotFixture();
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
      .toHaveTextContent("Native availability unverified");
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
