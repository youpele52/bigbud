import { type ProviderKind, type ServerProvider } from "@bigbud/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderModelPicker } from "./ProviderModelPicker";
import { getCustomModelOptionsByProvider } from "../../../models/provider";

function effort(value: string, isDefault = false) {
  return {
    value,
    label: value,
    ...(isDefault ? { isDefault: true } : {}),
  };
}

function buildProvider(
  models: ServerProvider["models"],
  provider: ProviderKind = "codex",
): ServerProvider {
  return {
    provider,
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
    slashCommands: [],
    skills: [],
  };
}

function buildModel(index: number) {
  return {
    slug: `model-${index}`,
    name: `Model ${index}`,
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  } as const;
}

function buildSubProviderModel(index: number, group: string, subProviderID: string) {
  return {
    ...buildModel(index),
    slug: `${subProviderID}-model-${index}`,
    name: `${group} Model ${index}`,
    group,
    subProviderID,
  };
}

async function mountLockedProviderPicker(
  models: ServerProvider["models"],
  selectedModel = models[0]?.slug ?? "",
  provider: ProviderKind = "codex",
) {
  const host = document.createElement("div");
  document.body.append(host);
  const providers = [buildProvider(models, provider)];
  const modelOptionsByProvider = getCustomModelOptionsByProvider(
    DEFAULT_UNIFIED_SETTINGS,
    providers,
    provider,
    selectedModel,
  );
  const onProviderModelChange = vi.fn();
  const screen = await render(
    <ProviderModelPicker
      provider={provider}
      model={selectedModel}
      lockedProvider={provider}
      providers={providers}
      modelOptionsByProvider={modelOptionsByProvider}
      onProviderModelChange={onProviderModelChange}
    />,
    { container: host },
  );

  return {
    onProviderModelChange,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ProviderModelPicker incremental rendering", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the first 5 models immediately and appends more on scroll", async () => {
    const models = Array.from({ length: 35 }, (_, index) => buildModel(index + 1));
    const mounted = await mountLockedProviderPicker(models);

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(5);
        expect(document.body.textContent ?? "").toContain("Model 5");
        expect(document.body.textContent ?? "").not.toContain("Model 6");
      });

      const scrollContainer = document.querySelector('[data-testid="provider-model-list-scroll"]');
      if (!(scrollContainer instanceof HTMLDivElement)) {
        throw new Error("Expected provider model list scroll container.");
      }

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(25);
        expect(document.body.textContent ?? "").toContain("Model 25");
        expect(document.body.textContent ?? "").not.toContain("Model 26");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("appends models from a downward wheel gesture when the first page does not overflow", async () => {
    const models = Array.from({ length: 35 }, (_, index) => buildModel(index + 1));
    const mounted = await mountLockedProviderPicker(models);

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(5);
      });

      const scrollContainer = document.querySelector('[data-testid="provider-model-list-scroll"]');
      if (!(scrollContainer instanceof HTMLDivElement)) {
        throw new Error("Expected provider model list scroll container.");
      }
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(25);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers an accessible fallback that appends the next 20 models", async () => {
    const models = Array.from({ length: 35 }, (_, index) => buildModel(index + 1));
    const mounted = await mountLockedProviderPicker(models);

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Show more models" }).click();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(25);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches and selects a late OpenCode sub-provider with routing identity", async () => {
    const models = [
      ...Array.from({ length: 25 }, (_, index) =>
        buildSubProviderModel(index + 1, "OpenCode Zen", "opencode"),
      ),
      ...Array.from({ length: 15 }, (_, index) =>
        buildSubProviderModel(index + 1, "OpenAI", "openai"),
      ),
    ];
    const mounted = await mountLockedProviderPicker(models, models[0]!.slug, "opencode");

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models").fill("OpenAI");

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(5);
        expect(document.body.textContent ?? "").toContain("OpenAI Model 1");
        expect(document.body.textContent ?? "").not.toContain("OpenAI Model 6");
      });

      await page.getByRole("menuitemradio", { name: "OpenAI Model 1" }).click();
      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "opencode",
        "openai-model-1",
        "openai",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not render through a far-away selected model on repeated opens", async () => {
    const models = Array.from({ length: 6_000 }, (_, index) => buildModel(index + 1));
    const mounted = await mountLockedProviderPicker(models, "model-6000");

    try {
      const trigger = page.getByRole("button").first();
      await trigger.click();

      await vi.waitFor(() => {
        const renderedModels = [...document.querySelectorAll('[role="menuitemradio"]')];
        expect(renderedModels).toHaveLength(5);
        expect(renderedModels.some((entry) => entry.textContent === "Model 6000")).toBe(false);
      });

      await trigger.click();
      await trigger.click();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(5);
        expect(document.body.textContent ?? "").toContain("Model 5");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches across the full model list before additional scrolling", async () => {
    const models = Array.from({ length: 35 }, (_, index) => buildModel(index + 1));
    const mounted = await mountLockedProviderPicker(models);

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models").fill("Model 35");

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Model 35");
        expect(document.body.textContent ?? "").not.toContain("Model 34");
        expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("applies a wider popup min-width for providers with more than 10 models", async () => {
    const models = Array.from({ length: 35 }, (_, index) => buildModel(index + 1));
    const mounted = await mountLockedProviderPicker(models);

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const popup = document.querySelector('[data-slot="menu-popup"]');
        expect(popup).not.toBeNull();
        expect(popup?.className).toContain("min-w-[40ch]");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
