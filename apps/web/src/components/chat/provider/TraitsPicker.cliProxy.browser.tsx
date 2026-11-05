import "../../../index.css";

import { ThreadId, type ServerProviderModel } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { CompactComposerControlsMenu } from "../common/CompactComposerControlsMenu";
import {
  getComposerProviderState,
  renderProviderTraitsMenuContent,
} from "./composerProviderRegistry";
import { COMPOSER_DRAFT_STORAGE_KEY, useComposerDraftStore } from "../../../stores/composer";

const threadId = ThreadId.makeUnsafe("cliproxy-effort");
const models: ServerProviderModel[] = [
  {
    slug: "gpt-6-astra",
    name: "GPT 6 Astra",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

afterEach(() => {
  localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
  useComposerDraftStore.setState({ draftsByThreadId: {}, stickyModelSelectionByProvider: {} });
});

it("shows CLIProxyAPI effort in composer controls and persists it for dispatch", async () => {
  useComposerDraftStore.getState().setModelSelection(threadId, {
    provider: "cliProxy",
    model: "gpt-6-astra",
  });
  const screen = await render(
    <CompactComposerControlsMenu
      interactionMode="default"
      planCardOpen={false}
      planCardLabel="Tasks"
      runtimeMode="approval-required"
      traitsMenuContent={renderProviderTraitsMenuContent({
        provider: "cliProxy",
        models,
        model: "gpt-6-astra",
        threadId,
        modelOptions: undefined,
        prompt: "",
        onPromptChange: vi.fn(),
      })}
      onOpenOrchestra={vi.fn()}
      onToggleInteractionMode={vi.fn()}
      onTogglePlanCard={vi.fn()}
      onRuntimeModeChange={vi.fn()}
    />,
  );
  try {
    await page.getByRole("button", { name: "More composer controls" }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Medium (default)" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Low", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("menuitemradio", { name: "High", exact: true }))
      .toBeVisible();
    expect(page.getByRole("menuitemradio", { name: "Ultrathink" }).query()).toBeNull();
    await page.getByRole("menuitemradio", { name: "Extra High" }).click();
    const selection =
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .cliProxy;
    expect(selection).toEqual({
      provider: "cliProxy",
      model: "gpt-6-astra",
      options: { effort: "xhigh" },
    });
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.cliProxy).toEqual(
      selection,
    );
    if (selection?.provider !== "cliProxy") throw new Error("Missing CLIProxyAPI selection");
    expect(
      getComposerProviderState({
        provider: "cliProxy",
        models,
        model: "gpt-6-astra",
        prompt: "",
        modelOptions: { cliProxy: selection?.options },
      }).modelOptionsForDispatch,
    ).toEqual({ effort: "xhigh" });
  } finally {
    await screen.unmount();
  }
});
