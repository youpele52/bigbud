import "../../../index.css";

import {
  type ModelSelection,
  ClaudeModelOptions,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
} from "@bigbud/contracts";
import { page } from "vitest/browser";
import { useCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TraitsPicker } from "./TraitsPicker";
import { useComposerDraftStore } from "../../../stores/composer";
import { useComposerThreadDraft, useEffectiveComposerModelState } from "../../../stores/composer";
import { ComposerThreadDraftState } from "../../../stores/composer";
import { DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/settings";
import { CLAUDE_THREAD_ID, TEST_PROVIDERS } from "./TraitsPicker.browser.fixtures";

// ── Claude TraitsPicker tests ─────────────────────────────────────────

function ClaudeTraitsPickerHarness(props: {
  model: string;
  fallbackModelSelection: ModelSelection | null;
  triggerVariant?: "ghost" | "outline";
}) {
  const prompt = useComposerThreadDraft(CLAUDE_THREAD_ID).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: CLAUDE_THREAD_ID,
    providers: TEST_PROVIDERS,
    selectedProvider: "claudeAgent",
    threadModelSelection: props.fallbackModelSelection,
    projectModelSelection: null,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...DEFAULT_CLIENT_SETTINGS,
    },
  });
  const handlePromptChange = useCallback(
    (nextPrompt: string) => {
      setPrompt(CLAUDE_THREAD_ID, nextPrompt);
    },
    [setPrompt],
  );

  return (
    <TraitsPicker
      provider="claudeAgent"
      models={TEST_PROVIDERS[1]!.models}
      threadId={CLAUDE_THREAD_ID}
      model={selectedModel ?? props.model}
      prompt={prompt}
      modelOptions={modelOptions?.claudeAgent}
      onPromptChange={handlePromptChange}
      triggerVariant={props.triggerVariant}
    />
  );
}

async function mountClaudePicker(props?: {
  model?: string;
  prompt?: string;
  options?: ClaudeModelOptions;
  fallbackModelOptions?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultrathink";
    thinking?: boolean;
    fastMode?: boolean;
  } | null;
  skipDraftModelOptions?: boolean;
  triggerVariant?: "ghost" | "outline";
}) {
  const model = props?.model ?? "claude-opus-4-6";
  const claudeOptions = !props?.skipDraftModelOptions ? props?.options : undefined;
  const draftsByThreadId: Record<ThreadId, ComposerThreadDraftState> = {
    [CLAUDE_THREAD_ID]: {
      prompt: props?.prompt ?? "",
      images: [],
      files: [],
      annotations: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      persistedFileAttachments: [],
      terminalContexts: [],
      modelSelectionByProvider: props?.skipDraftModelOptions
        ? {}
        : {
            claudeAgent: {
              provider: "claudeAgent",
              model,
              ...(claudeOptions && Object.keys(claudeOptions).length > 0
                ? { options: claudeOptions }
                : {}),
            },
          },
      activeProvider: "claudeAgent",
      runtimeMode: null,
      interactionMode: null,
      shellMode: false,
      bootstrapSourceThreadId: null,
      replyTarget: null,
    },
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const fallbackModelSelection =
    props?.fallbackModelOptions !== undefined
      ? ({
          provider: "claudeAgent",
          model,
          ...(props.fallbackModelOptions ? { options: props.fallbackModelOptions } : {}),
        } satisfies ModelSelection)
      : null;
  const screen = await render(
    <ClaudeTraitsPickerHarness
      model={model}
      fallbackModelSelection={fallbackModelSelection}
      {...(props?.triggerVariant ? { triggerVariant: props.triggerVariant } : {})}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

describe("TraitsPicker (Claude)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode controls for Opus", async () => {
    await using _ = await mountClaudePicker();

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("off");
      expect(text).toContain("on");
    });
  });

  it("hides fast mode controls for non-Opus models", async () => {
    await using _ = await mountClaudePicker({ model: "claude-sonnet-4-6" });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Fast Mode");
    });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-sonnet-4-6",
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Low");
      expect(text).toContain("Medium");
      expect(text).toContain("High");
      expect(text).not.toContain("Max");
      expect(text).toContain("Ultrathink");
    });
  });

  it("shows a th  inking on/off dropdown for Haiku", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-haiku-4-5",
      options: { thinking: true },
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Thinking On");
    });
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Thinking");
      expect(text).toContain("On (default)");
      expect(text).toContain("Off");
    });
  });

  it("shows prompt-controlled Ultrathink state with selectable effort controls", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "high" },
      prompt: "Ultrathink:\nInvestigate this",
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Ultrathink");
      expect(document.body.textContent ?? "").not.toContain("Ultrathink · Prompt");
    });
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Effort");
      expect(text).not.toContain("ultrathink");
    });
  });

  it("warns when ultrathink appears in prompt body text", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "high" },
      prompt: "Ultrathink:\nplease ultrathink about this problem",
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain(
        'Your prompt contains "ultrathink" in the text. Remove it to change effort.',
      );
    });
  });

  it("persists sticky claude model options when traits change", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "medium", fastMode: false },
    });

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "Max" }).click();

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent,
    ).toMatchObject({
      provider: "claudeAgent",
      options: {
        effort: "max",
      },
    });
  });

  it("accepts outline trigger styling", async () => {
    await using _ = await mountClaudePicker({
      triggerVariant: "outline",
    });

    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Expected traits trigger button to be rendered.");
    }
    expect(button.className).toContain("border-input");
    expect(button.className).toContain("bg-popover");
  });
});
