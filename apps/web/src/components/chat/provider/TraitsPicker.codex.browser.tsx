import "../../../index.css";

import {
  type CodexModelOptions,
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TraitsPicker } from "./TraitsPicker";
import { TEST_PROVIDERS } from "./TraitsPicker.browser.fixtures";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  type ComposerThreadDraftState,
  useComposerDraftStore,
} from "../../../stores/composer";

async function mountCodexPicker(props: { model?: string; options?: CodexModelOptions }) {
  const threadId = ThreadId.makeUnsafe("thread-codex-traits");
  const model = props.model ?? DEFAULT_MODEL_BY_PROVIDER.codex;
  const draftsByThreadId: Record<ThreadId, ComposerThreadDraftState> = {
    [threadId]: {
      prompt: "",
      images: [],
      files: [],
      annotations: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      persistedFileAttachments: [],
      terminalContexts: [],
      modelSelectionByProvider: {
        codex: {
          provider: "codex",
          model,
          ...(props.options ? { options: props.options } : {}),
        },
      },
      activeProvider: "codex",
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
    projectDraftThreadIdByProjectId: {
      [ProjectId.makeUnsafe("project-codex-traits")]: threadId,
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <TraitsPicker
      provider="codex"
      models={TEST_PROVIDERS[0]!.models}
      threadId={threadId}
      model={model}
      prompt=""
      modelOptions={props.options}
      onPromptChange={() => {}}
    />,
    { container: host },
  );
  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };
  return { [Symbol.asyncDispose]: cleanup, cleanup };
}

describe("TraitsPicker (Codex)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode controls", async () => {
    await using _ = await mountCodexPicker({ options: { fastMode: false } });
    await page.getByRole("button").click();
    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("off");
      expect(text).toContain("on");
    });
  });

  it("shows Fast in the trigger label when fast mode is active", async () => {
    await using _ = await mountCodexPicker({ options: { fastMode: true } });
    await vi.waitFor(() => expect(document.body.textContent ?? "").toContain("High · Fast"));
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountCodexPicker({ options: { fastMode: false } });
    await page.getByRole("button").click();
    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Extra High");
      expect(text).toContain("High");
      expect(text).not.toContain("Low");
      expect(text).not.toContain("Medium");
    });
  });

  it("persists sticky codex model options when traits change", async () => {
    await using _ = await mountCodexPicker({ options: { fastMode: false } });
    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "on" }).click();
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toMatchObject({
      provider: "codex",
      options: { fastMode: true },
    });
  });
});
