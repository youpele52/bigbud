import "../../../index.css";

import type { ServerProvider } from "@bigbud/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { getCustomModelOptionsByProvider } from "../../../models/provider";
import { ProviderModelPicker } from "./ProviderModelPicker";

function museProvider(): ServerProvider {
  return {
    provider: "muse",
    enabled: true,
    installed: true,
    version: "1.4.14",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-29T00:00:00.000Z",
    models: [
      {
        slug: "muse-spark-1.3-contributor",
        name: "Muse Spark 1.3 Contributor",
        isCustom: false,
        capabilities: null,
        subProviderID: "meta",
        contributorTraining: true,
      },
      {
        slug: "muse-spark-1.3",
        name: "Muse Spark 1.3",
        isCustom: false,
        capabilities: null,
        subProviderID: "meta",
      },
    ],
    slashCommands: [],
    skills: [],
    supportsAttachments: false,
    supportedRuntimeModes: ["auto-accept-edits"],
  };
}

describe("ProviderModelPicker Muse Code", () => {
  it("discloses Contributor training use in the catalog picker before selection", async () => {
    const snapshot = museProvider();
    const screen = await render(
      <ProviderModelPicker
        provider="muse"
        model="muse-spark-1.3"
        lockedProvider="muse"
        providers={[snapshot]}
        modelOptionsByProvider={getCustomModelOptionsByProvider(
          DEFAULT_UNIFIED_SETTINGS,
          [snapshot],
          "muse",
          "muse-spark-1.3",
        )}
        onProviderModelChange={vi.fn()}
      />,
    );
    try {
      await page.getByRole("button").click();
      await expect.element(page.getByText("content may be used for training")).toBeVisible();
      await expect.element(page.getByText("Muse Spark 1.3").first()).toBeVisible();
      await expect.element(page.getByText("Muse Spark 1.3 Contributor").first()).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
