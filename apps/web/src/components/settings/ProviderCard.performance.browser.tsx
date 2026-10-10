import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProviderCard } from "./ProviderCard";
import { buildProviderCards } from "./ProvidersSettingsSection.logic";

const noop = () => {};

function createProps(isOpen: boolean) {
  const card = buildProviderCards({ settings: DEFAULT_UNIFIED_SETTINGS, serverProviders: [] }).find(
    (value) => value.provider === "opencode",
  )!;
  const readSlug = vi.fn();
  return {
    readSlug,
    props: {
      card: {
        ...card,
        models: Array.from({ length: 2_000 }, (_, index) => ({
          get slug() {
            readSlug();
            return `catalog-${index}`;
          },
          name: `catalog model ${index}`,
          isCustom: index === 1_999,
          capabilities: null,
        })),
      },
      isOpen,
      codexHomePath: "",
      customModelInput: "",
      customModelError: null,
      modelListRef: { current: null as HTMLDivElement | null },
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
      onRemoveCustomModel: vi.fn(),
    },
  };
}

it("does not traverse a collapsed provider's model catalog", async () => {
  const { props, readSlug } = createProps(false);
  const screen = await render(<ProviderCard {...props} />);
  try {
    expect(readSlug.mock.calls.length).toBe(0);
  } finally {
    await screen.unmount();
  }
});

it("keeps small and updated catalogs visible, including newly appended custom models", async () => {
  const { props } = createProps(true);
  const screen = await render(<ProviderCard {...props} card={{ ...props.card, models: [] }} />);
  try {
    await expect.element(page.getByText("0 models available.")).toBeInTheDocument();
    await screen.rerender(
      <ProviderCard {...props} card={{ ...props.card, models: props.card.models.slice(0, 1) }} />,
    );
    await expect.element(page.getByText("catalog model 0", { exact: true })).toBeInTheDocument();
    await screen.rerender(<ProviderCard {...props} />);
    const customModel = {
      slug: "new-custom-model",
      name: "New custom model",
      isCustom: true,
      capabilities: null,
    };
    await screen.rerender(
      <ProviderCard
        {...props}
        card={{ ...props.card, models: [...props.card.models, customModel] }}
      />,
    );
    // The settings section uses this same ref to reveal newly added models.
    const list = props.modelListRef.current!;
    list.scrollTo({ top: list.scrollHeight });
    await expect
      .element(page.getByRole("button", { name: "Remove new-custom-model" }))
      .toBeInTheDocument();
    await screen.rerender(
      <ProviderCard {...props} card={{ ...props.card, models: [customModel] }} />,
    );
    await expect.element(page.getByText("New custom model", { exact: true })).toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("bounds expanded model rendering and keeps the end of a large catalog accessible", async () => {
  const { props } = createProps(true);
  const startedAt = performance.now();
  const screen = await render(<ProviderCard {...props} />);
  console.info(`Expanded provider catalog mount: ${Math.round(performance.now() - startedAt)}ms`);
  try {
    await expect.element(page.getByText("2000 models available.")).toBeInTheDocument();
    await expect.element(page.getByText("catalog model 0", { exact: true })).toBeInTheDocument();
    expect(
      document.querySelectorAll('[aria-label^="Details for catalog model"]').length,
    ).toBeLessThan(30);
    const list = props.modelListRef.current!;
    list.scrollTo({ top: list.scrollHeight });
    await expect
      .element(page.getByRole("button", { name: "Remove catalog-1999" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Remove catalog-1999" }).click();
    expect(props.onRemoveCustomModel).toHaveBeenCalledWith("catalog-1999");
  } finally {
    await screen.unmount();
  }
});
