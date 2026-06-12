import { DEFAULT_UNIFIED_SETTINGS, ThreadId, type ServerProvider } from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveEffectiveComposerModelState } from "./composer.store";
import { useComposerDraftStore } from "./composer.store";
import { normalizeCurrentPersistedComposerDraftStoreState } from "./migration.store";
import {
  modelSelection,
  opencodeModelSelection,
  providerModelOptions,
  resetComposerDraftStore,
} from "./composer.store.test.utils";

describe("composerDraftStore modelSelection", () => {
  const threadId = ThreadId.makeUnsafe("thread-model-options");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a model selection in the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadId,
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );
  });

  it("normalizes upstream-style option arrays in current persisted selections", () => {
    const state = normalizeCurrentPersistedComposerDraftStoreState({
      draftsByThreadId: {
        [threadId]: {
          prompt: "",
          attachments: [],
          modelSelectionByProvider: {
            codex: {
              provider: "codex",
              model: "gpt-5.4",
              options: [
                { id: "reasoningEffort", value: "high" },
                { id: "fastMode", value: true },
              ],
            },
            cursor: {
              provider: "cursor",
              model: "auto",
              options: [
                { id: "reasoning", value: "medium" },
                { id: "contextWindow", value: "large" },
                { id: "thinking", value: true },
              ],
            },
          },
          activeProvider: "cursor",
        },
      },
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: [
            { id: "effort", value: "max" },
            { id: "thinking", value: false },
          ],
        },
      },
      stickyActiveProvider: "claudeAgent",
    });

    const draft = state.draftsByThreadId[threadId];
    expect(draft).toBeDefined();
    expect(draft?.modelSelectionByProvider?.codex).toEqual(
      modelSelection("codex", "gpt-5.4", { reasoningEffort: "high", fastMode: true }),
    );
    expect(draft?.modelSelectionByProvider?.cursor).toEqual({
      provider: "cursor",
      model: "auto",
      options: { reasoning: "medium", contextWindow: "large", thinking: true },
    });
    expect(draft?.activeProvider).toBe("cursor");
    expect(state.stickyModelSelectionByProvider?.claudeAgent).toEqual(
      modelSelection("claudeAgent", "opus", { effort: "max", thinking: false }),
    );
    expect(state.stickyActiveProvider).toBe("claudeAgent");
  });

  it("keeps default-only model selections on the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4"));

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(modelSelection("codex", "gpt-5.4"));
  });

  it("preserves OpenCode sub-provider identity when updating a draft selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadId,
      opencodeModelSelection("gpt-5-mini", {
        subProviderID: "openai",
      }),
    );

    store.setProviderModelOptions(
      threadId,
      "opencode",
      {
        reasoningEffort: "high",
      },
      { persistSticky: true },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .opencode,
    ).toEqual(
      opencodeModelSelection("gpt-5-mini", {
        subProviderID: "openai",
        options: { reasoningEffort: "high" },
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.opencode).toEqual(
      opencodeModelSelection("gpt-5-mini", {
        subProviderID: "openai",
        options: { reasoningEffort: "high" },
      }),
    );
  });

  it("replaces only the targeted provider options on the current model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "opus", {
        effort: "max",
        fastMode: true,
      }),
    );
    store.setStickyModelSelection(
      modelSelection("claudeAgent", "opus", {
        effort: "max",
        fastMode: true,
      }),
    );

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      {
        thinking: false,
      },
      { persistSticky: true },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "opus", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "opus", {
        thinking: false,
      }),
    );
  });

  it("keeps explicit default-state overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "opus", {
        effort: "max",
      }),
    );

    store.setProviderModelOptions(threadId, "claudeAgent", {
      thinking: true,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "opus", {
        thinking: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({});
  });

  it("keeps explicit off/default codex overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4", { fastMode: true }));

    store.setProviderModelOptions(threadId, "codex", {
      reasoningEffort: "high",
      fastMode: false,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(
      modelSelection("codex", "gpt-5.4", {
        reasoningEffort: "high",
        fastMode: false,
      }),
    );
  });

  it("updates only the draft when sticky persistence is omitted", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(modelSelection("claudeAgent", "opus", { effort: "max" }));
    store.setModelSelection(threadId, modelSelection("claudeAgent", "opus", { effort: "max" }));

    store.setProviderModelOptions(threadId, "claudeAgent", {
      thinking: false,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "opus", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "opus", { effort: "max" }),
    );
  });

  it("does not clear other provider options when setting options for a single provider", () => {
    const store = useComposerDraftStore.getState();

    // Set options for both providers
    store.setModelOptions(
      threadId,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    // Now set options for only codex — claudeAgent should be untouched
    store.setModelOptions(threadId, providerModelOptions({ codex: { reasoningEffort: "xhigh" } }));

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.codex?.options).toEqual({ reasoningEffort: "xhigh" });
    expect(draft?.modelSelectionByProvider.claudeAgent?.options).toEqual({ effort: "max" });
  });

  it("preserves other provider options when switching the active model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelOptions(
      threadId,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    store.setModelSelection(threadId, modelSelection("claudeAgent", "opus"));

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "opus", { effort: "max" }),
    );
    expect(draft?.modelSelectionByProvider.codex?.options).toEqual({ fastMode: true });
    expect(draft?.activeProvider).toBe("claudeAgent");
  });

  it("creates the first sticky snapshot from provider option changes", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4"));

    store.setProviderModelOptions(
      threadId,
      "codex",
      {
        fastMode: true,
      },
      { persistSticky: true },
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4", {
        fastMode: true,
      }),
    );
  });

  it("updates only the draft when sticky persistence is disabled", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(modelSelection("claudeAgent", "opus", { effort: "max" }));
    store.setModelSelection(threadId, modelSelection("claudeAgent", "opus", { effort: "max" }));

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      {
        thinking: false,
      },
      { persistSticky: false },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "opus", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "opus", { effort: "max" }),
    );
  });
});

describe("composerDraftStore setModelSelection", () => {
  const threadId = ThreadId.makeUnsafe("thread-model");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("keeps explicit model overrides instead of coercing to null", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.3-codex"));

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(modelSelection("codex", "gpt-5.3-codex"));
  });

  it("does not carry a previous provider model across provider fallback", () => {
    const providers = [
      {
        provider: "codex",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00.000Z",
        message: undefined,
        models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
        slashCommands: [],
        skills: [],
      },
    ] satisfies ReadonlyArray<ServerProvider>;

    const result = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: "codex",
      threadModelSelection: { provider: "devin", model: "default" },
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(result.selectedModel).toBe("gpt-5.4");
  });
});
