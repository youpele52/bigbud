import "../../../index.css";

import { ThreadId, type ServerProviderModel } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { renderProviderTraitsPicker, getComposerProviderState } from "./composerProviderRegistry";
import { COMPOSER_DRAFT_STORAGE_KEY, useComposerDraftStore } from "../../../stores/composer";

const threadId = ThreadId.makeUnsafe("v2-effort");
const models: ServerProviderModel[] = [
  {
    slug: "same-model",
    subProviderID: "first",
    name: "First model",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [{ value: "other-variant", label: "Other variant" }],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "same-model",
    subProviderID: "second",
    name: "Second model",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "xhigh", label: "Extra High" },
        { value: "native-custom", label: "Native custom" },
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

it.each(["xhigh", "native-custom"])(
  "persists and dispatches the selected native variant %s",
  async (variant) => {
    useComposerDraftStore.getState().setModelSelection(threadId, {
      provider: "opencodeV2",
      model: "same-model",
      subProviderID: "second",
      options: { variant: "low" },
    });
    function ComposerTraits() {
      const selection = useComposerDraftStore(
        (state) => state.draftsByThreadId[threadId]?.modelSelectionByProvider.opencodeV2,
      );
      return renderProviderTraitsPicker({
        provider: "opencodeV2",
        models,
        model: "same-model",
        subProviderID: "second",
        threadId,
        modelOptions: selection?.options,
        prompt: "",
        onPromptChange: () => {},
      });
    }
    const screen = await render(<ComposerTraits />);
    try {
      await page.getByRole("button", { name: "Low" }).click();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Other variant" }))
        .not.toBeInTheDocument();
      const label = variant === "xhigh" ? "Extra High" : "Native custom";
      await page.getByRole("menuitemradio", { name: label }).click();
      await expect.element(page.getByRole("button", { name: label })).toBeVisible();
      const selection =
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
          .opencodeV2;
      expect(selection).toEqual({
        provider: "opencodeV2",
        model: "same-model",
        subProviderID: "second",
        options: { variant },
      });
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.opencodeV2).toEqual(
        selection,
      );
      if (selection?.provider !== "opencodeV2") throw new Error("Missing OpenCode v2 selection");
      expect(
        getComposerProviderState({
          provider: "opencodeV2",
          models,
          model: "same-model",
          subProviderID: "second",
          modelOptions: { opencodeV2: selection?.options },
          prompt: "",
        }).modelOptionsForDispatch,
      ).toEqual({ variant });
    } finally {
      await screen.unmount();
    }
  },
);
