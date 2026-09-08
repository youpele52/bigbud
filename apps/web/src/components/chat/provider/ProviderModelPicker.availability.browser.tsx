import "../../../index.css";

import type { ServerProvider } from "@bigbud/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { getCustomModelOptionsByProvider } from "../../../models/provider";
import { ProviderModelPicker } from "./ProviderModelPicker";

function provider(): ServerProvider {
  return {
    provider: "cursor",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-27T00:00:00.000Z",
    models: [
      {
        slug: "cursor-default",
        name: "Cursor Default",
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

describe("ProviderModelPicker unavailable provider accessibility", () => {
  it("renders the computed remote-workspace message on the disabled option", async () => {
    const snapshot = provider();
    const modelOptionsByProvider = getCustomModelOptionsByProvider(
      DEFAULT_UNIFIED_SETTINGS,
      [snapshot],
      "cursor",
      "cursor-default",
    );
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <ProviderModelPicker
        provider="cursor"
        model="cursor-default"
        lockedProvider={null}
        providers={[snapshot]}
        workspaceExecutionTargetId="ssh:devbox"
        modelOptionsByProvider={modelOptionsByProvider}
        onProviderModelChange={vi.fn()}
      />,
      { container: host },
    );

    try {
      await page.getByRole("button").click();
      const option = page.getByRole("menuitem", {
        name: /Cursor Provider does not support a remote workspace with a local runtime/,
      });
      await expect.element(option).toBeVisible();
      await expect.element(option).toBeDisabled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
