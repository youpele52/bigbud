import "../../../index.css";

import type { PiModelOptions, ServerProviderModel } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TraitsPicker } from "./TraitsPicker";

const PI_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "reasoning-model",
    name: "Reasoning model",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "off", label: "Off" },
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

describe("TraitsPicker (Pi)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows Pi default on a fresh selection and persists the first explicit choice", async () => {
    const onModelOptionsChange = vi.fn<(options: PiModelOptions | undefined) => void>();
    const screen = await render(
      <TraitsPicker
        provider="pi"
        models={PI_MODELS}
        model="reasoning-model"
        prompt=""
        onPromptChange={() => undefined}
        onModelOptionsChange={onModelOptionsChange as never}
      />,
    );

    await expect.element(page.getByRole("button", { name: /Pi default/ })).toBeVisible();
    await page.getByRole("button", { name: /Pi default/ }).click();
    await expect.element(page.getByRole("menuitemradio", { name: "Pi default" })).toBeVisible();
    await expect.element(page.getByRole("menuitemradio", { name: "High" })).toBeVisible();
    expect(page.getByRole("menuitemradio", { name: "Minimal" }).query()).toBeNull();
    expect(page.getByRole("menuitemradio", { name: "Extra High" }).query()).toBeNull();

    await page.getByRole("menuitemradio", { name: "High" }).click();
    expect(onModelOptionsChange).toHaveBeenCalledWith({ thinkingLevel: "high" });

    await screen.unmount();
  });
});
