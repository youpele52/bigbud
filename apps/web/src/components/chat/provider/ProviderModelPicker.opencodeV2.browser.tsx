import "../../../index.css";
import type { ServerProvider } from "@bigbud/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { getCustomModelOptionsByProvider } from "../../../models/provider";
import { ProviderModelPicker } from "./ProviderModelPicker";

function snapshotFixture(): ServerProvider {
  return {
    provider: "opencodeV2",
    enabled: true,
    installed: true,
    version: "2.0.19",
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
