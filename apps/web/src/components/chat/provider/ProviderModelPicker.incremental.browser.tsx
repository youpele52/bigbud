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

function buildProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    provider: "codex",
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

async function mountLockedProviderPicker(models: ServerProvider["models"]) {
  const host = document.createElement("div");
  document.body.append(host);
  const provider = "codex" as const satisfies ProviderKind;
  const providers = [buildProvider(models)];
  const modelOptionsByProvider = getCustomModelOptionsByProvider(
    DEFAULT_UNIFIED_SETTINGS,
    providers,
    provider,
    models[0]?.slug ?? "",
  );
  const screen = await render(
    <ProviderModelPicker
      provider={provider}
      model={models[0]?.slug ?? ""}
      lockedProvider={provider}
      providers={providers}
      modelOptionsByProvider={modelOptionsByProvider}
      onProviderModelChange={vi.fn()}
    />,
    { container: host },
  );

  return {
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

  it("renders the first 10 models immediately and appends more on scroll", async () => {
    const models = Array.from({ length: 35 }, (_, index) => buildModel(index + 1));
    const mounted = await mountLockedProviderPicker(models);

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(10);
        expect(document.body.textContent ?? "").toContain("Model 10");
        expect(document.body.textContent ?? "").not.toContain("Model 11");
      });

      const scrollContainer = document.querySelector('[data-testid="provider-model-list-scroll"]');
      if (!(scrollContainer instanceof HTMLDivElement)) {
        throw new Error("Expected provider model list scroll container.");
      }

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(30);
        expect(document.body.textContent ?? "").toContain("Model 30");
        expect(document.body.textContent ?? "").not.toContain("Model 31");
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
