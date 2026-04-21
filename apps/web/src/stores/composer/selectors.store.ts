import {
  type ModelSelection,
  type ProviderKind,
  type ServerProvider,
  type ThreadId,
} from "@bigbud/contracts";
import { useMemo } from "react";
import { UnifiedSettings } from "@bigbud/contracts/settings";
import {
  EMPTY_THREAD_DRAFT,
  type ComposerThreadDraftState,
  type EffectiveComposerModelState,
} from "./types.store";
import { deriveEffectiveComposerModelState } from "./normalization.store";
import { useComposerDraftStore } from "./composer.store";

// ── Selector hooks ────────────────────────────────────────────────────

export function useComposerThreadDraft(threadId: ThreadId): ComposerThreadDraftState {
  return useComposerDraftStore((state) => state.draftsByThreadId[threadId] ?? EMPTY_THREAD_DRAFT);
}

export function useEffectiveComposerModelState(input: {
  threadId: ThreadId;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderKind;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const draft = useComposerThreadDraft(input.threadId);

  return useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft,
        providers: input.providers,
        selectedProvider: input.selectedProvider,
        threadModelSelection: input.threadModelSelection,
        projectModelSelection: input.projectModelSelection,
        settings: input.settings,
      }),
    [
      draft,
      input.providers,
      input.settings,
      input.projectModelSelection,
      input.selectedProvider,
      input.threadModelSelection,
    ],
  );
}
