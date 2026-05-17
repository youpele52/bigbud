import { type ThreadId } from "@bigbud/contracts";
import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useLocalStorage } from "~/hooks/useLocalStorage";

import { type TerminalContextDraft } from "../../../../lib/terminalContext";
import { type ChatMessage } from "../../../../models/types";
import {
  type ComposerAnnotationAttachment,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "../../../../stores/composer";
import { useStore } from "../../../../stores/main";
import { selectThreadTerminalState, useTerminalStateStore } from "../../../../stores/terminal";
import { type ExpandedImagePreview } from "../../common/ExpandedImagePreview";
import {
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  PullRequestDialogState,
} from "../ChatView.logic";

import { type TerminalLaunchContext } from "./shared";

export function useChatViewBaseEphemeralState(input: {
  threadId: ThreadId;
  prompt: string;
  composerImages: ComposerImageAttachment[];
  composerFiles: ComposerFileAttachment[];
  composerAnnotations: ComposerAnnotationAttachment[];
  composerTerminalContexts: TerminalContextDraft[];
}) {
  const {
    threadId,
    prompt,
    composerImages,
    composerFiles,
    composerAnnotations,
    composerTerminalContexts,
  } = input;

  const promptRef = useRef(prompt);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const isConnecting = false;
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<
      string,
      Record<string, import("../../../../logic/user-input").PendingUserInputDraftAnswer>
    >
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [providerUnlocked, setProviderUnlocked] = useState(false);
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [terminalLaunchContext, setTerminalLaunchContext] = useState<TerminalLaunchContext | null>(
    null,
  );
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const composerImagesRef = useRef(composerImages);
  const composerFilesRef = useRef(composerFiles);
  const composerAnnotationsRef = useRef(composerAnnotations);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<
    import("../../composer/ComposerCommandMenu").ComposerCommandItem[]
  >([]);
  const activeComposerMenuItemRef = useRef<
    import("../../composer/ComposerCommandMenu").ComposerCommandItem | null
  >(null);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});

  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const terminalState = useMemo(
    () => selectThreadTerminalState(terminalStateByThreadId, threadId),
    [terminalStateByThreadId, threadId],
  );
  const openTerminalThreadIds = useTerminalStateStore(
    useShallow((state) =>
      Object.entries(state.terminalStateByThreadId).flatMap(([nextThreadId, nextTerminalState]) =>
        nextTerminalState.terminalOpen ? [nextThreadId as ThreadId] : [],
      ),
    ),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);
  const storeServerTerminalLaunchContext = useTerminalStateStore(
    (s) => s.terminalLaunchContextByThreadId[threadId] ?? null,
  );
  const storeClearTerminalLaunchContext = useTerminalStateStore(
    (s) => s.clearTerminalLaunchContext,
  );

  const threads = useStore((state) => state.threads);
  const serverThreadIds = useStore(useShallow((state) => state.threads.map((thread) => thread.id)));
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const draftThreadIds = useComposerDraftStore(
    useShallow((store) => Object.keys(store.draftThreadsByThreadId) as ThreadId[]),
  );
  const [mountedTerminalThreadIds, setMountedTerminalThreadIds] = useState<ThreadId[]>([]);

  return {
    promptRef,
    isDragOverComposer,
    setIsDragOverComposer,
    expandedImage,
    setExpandedImage,
    optimisticUserMessages,
    setOptimisticUserMessages,
    optimisticUserMessagesRef,
    composerTerminalContextsRef,
    localDraftErrorsByThreadId,
    setLocalDraftErrorsByThreadId,
    isConnecting,
    isRevertingCheckpoint,
    setIsRevertingCheckpoint,
    pendingUserInputAnswersByRequestId,
    setPendingUserInputAnswersByRequestId,
    pendingUserInputQuestionIndexByRequestId,
    setPendingUserInputQuestionIndexByRequestId,
    expandedWorkGroups,
    setExpandedWorkGroups,
    planSidebarOpen,
    setPlanSidebarOpen,
    providerUnlocked,
    setProviderUnlocked,
    planSidebarDismissedForTurnRef,
    planSidebarOpenOnNextThreadRef,
    nowTick,
    setNowTick,
    terminalFocusRequestId,
    setTerminalFocusRequestId,
    composerHighlightedItemId,
    setComposerHighlightedItemId,
    pullRequestDialogState,
    setPullRequestDialogState,
    terminalLaunchContext,
    setTerminalLaunchContext,
    attachmentPreviewHandoffByMessageId,
    setAttachmentPreviewHandoffByMessageId,
    lastInvokedScriptByProjectId,
    setLastInvokedScriptByProjectId,
    composerImagesRef,
    composerFilesRef,
    composerAnnotationsRef,
    composerSelectLockRef,
    composerMenuOpenRef,
    composerMenuItemsRef,
    activeComposerMenuItemRef,
    attachmentPreviewHandoffByMessageIdRef,
    attachmentPreviewHandoffTimeoutByMessageIdRef,
    sendInFlightRef,
    dragDepthRef,
    terminalOpenByThreadRef,
    terminalStateByThreadId,
    terminalState,
    openTerminalThreadIds,
    storeSetTerminalOpen,
    storeSplitTerminal,
    storeNewTerminal,
    storeSetActiveTerminal,
    storeCloseTerminal,
    storeServerTerminalLaunchContext,
    storeClearTerminalLaunchContext,
    threads,
    serverThreadIds,
    draftThreadsByThreadId,
    draftThreadIds,
    mountedTerminalThreadIds,
    setMountedTerminalThreadIds,
  };
}
