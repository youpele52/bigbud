import { type ThreadId } from "@bigbud/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { randomUUID } from "~/lib/utils";

import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
} from "../../../../logic/composer";
import { useSettings } from "../../../../hooks/useSettings";
import { useTheme } from "../../../../hooks/useTheme";
import {
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "../../../../lib/terminalContext";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
} from "../../../../models/types";
import { useComposerDraftStore, useComposerThreadDraft } from "../../../../stores/composer";
import { useProjectById, useStore, useThreadById } from "../../../../stores/main";
import { selectThreadTerminalState, useTerminalStateStore } from "../../../../stores/terminal";
import { useUiStateStore } from "../../../../stores/ui";
import { parseDiffRouteSearch } from "../../../../utils/diff";
import { type ComposerCommandItem } from "../../composer/ComposerCommandMenu";
import { type ComposerPromptEditorHandle } from "../../composer/ComposerPromptEditor";
import { type ExpandedImagePreview } from "../../common/ExpandedImagePreview";
import {
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  PullRequestDialogState,
  buildLocalDraftThread,
  deriveComposerSendState,
  reconcileMountedTerminalThreadIds,
} from "../ChatView.logic";

import { type TerminalLaunchContext } from "./shared";
import { useServerProviders } from "../../../../rpc/serverState";
import { getDefaultModelSelection } from "../../../../models/provider/provider.models";

const EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID: Record<string, boolean> = {};

interface ChatViewBaseStateInput {
  threadId: ThreadId;
}

export function useChatViewBaseState({ threadId }: ChatViewBaseStateInput) {
  const serverThread = useThreadById(threadId);
  const setStoreThreadError = useStore((store) => store.setError);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[threadId],
  );
  const threadChangedFilesExpandedByTurnId = useUiStateStore((store) =>
    serverThread
      ? (store.threadChangedFilesExpandedById[threadId] ?? EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID)
      : EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID,
  );
  const setThreadChangedFilesExpanded = useUiStateStore(
    (store) => store.setThreadChangedFilesExpanded,
  );
  const settings = useSettings();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const serverProviders = useServerProviders();
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerFiles = composerDraft.files;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        fileCount: composerFiles.length,
        terminalContexts: composerTerminalContexts,
      }),
    [composerFiles.length, composerImages.length, composerTerminalContexts, prompt],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftFile = useComposerDraftStore((store) => store.addFile);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftFile = useComposerDraftStore((store) => store.removeFile);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const setBootstrapSourceThreadId = useComposerDraftStore(
    (store) => store.setBootstrapSourceThreadId,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );

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
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerImagesRef = useRef(composerImages);
  const composerFilesRef = useRef(composerFiles);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
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
  const openTerminalThreadIds = useMemo(
    () =>
      Object.entries(terminalStateByThreadId).flatMap(([nextThreadId, nextTerminalState]) =>
        nextTerminalState.terminalOpen ? [nextThreadId as ThreadId] : [],
      ),
    [terminalStateByThreadId],
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
  const serverThreadIds = useMemo(() => threads.map((thread) => thread.id), [threads]);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const draftThreadIds = useMemo(
    () => Object.keys(draftThreadsByThreadId) as ThreadId[],
    [draftThreadsByThreadId],
  );
  const [mountedTerminalThreadIds, setMountedTerminalThreadIds] = useState<ThreadId[]>([]);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const addComposerImage = useCallback(
    (image: (typeof composerImages)[number]) => {
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: typeof composerImages) => {
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );
  const addComposerFile = useCallback(
    (file: Parameters<typeof addComposerDraftFile>[1]) => {
      addComposerDraftFile(threadId, file);
    },
    [addComposerDraftFile, threadId],
  );
  const addComposerFilesToDraft = useCallback(
    (files: Parameters<typeof addComposerDraftFiles>[1]) => {
      addComposerDraftFiles(threadId, files);
    },
    [addComposerDraftFiles, threadId],
  );
  const removeComposerFileFromDraft = useCallback(
    (fileId: string) => {
      removeComposerDraftFile(threadId, fileId);
    },
    [removeComposerDraftFile, threadId],
  );
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(threadId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [composerTerminalContexts, removeComposerDraftTerminalContext, setPrompt, threadId],
  );

  const fallbackDraftProject = useProjectById(draftThread?.projectId);
  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ??
              getDefaultModelSelection(serverProviders),
            localDraftError,
          )
        : undefined,
    [
      draftThread,
      fallbackDraftProject?.defaultModelSelection,
      localDraftError,
      serverProviders,
      threadId,
    ],
  );
  const activeThread = serverThread ?? localDraftThread;
  const runtimeMode =
    composerDraft.runtimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerDraft.interactionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const diffOpen = rawSearch.diff === "1";
  const activeThreadId = activeThread?.id ?? null;
  const existingOpenTerminalThreadIds = useMemo(() => {
    const existingThreadIds = new Set<ThreadId>([...serverThreadIds, ...draftThreadIds]);
    return openTerminalThreadIds.filter((nextThreadId) => existingThreadIds.has(nextThreadId));
  }, [draftThreadIds, openTerminalThreadIds, serverThreadIds]);
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const activeProject = useProjectById(activeThread?.projectId);
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeTerminalLaunchContext =
    terminalLaunchContext?.threadId === activeThreadId
      ? terminalLaunchContext
      : (storeServerTerminalLaunchContext ?? null);

  return {
    threadId,
    serverThread,
    setStoreThreadError,
    markThreadVisited,
    activeThreadLastVisitedAt,
    threadChangedFilesExpandedByTurnId,
    setThreadChangedFilesExpanded,
    settings,
    setStickyComposerModelSelection,
    timestampFormat,
    navigate,
    rawSearch,
    resolvedTheme,
    composerDraft,
    prompt,
    composerImages,
    composerFiles,
    composerTerminalContexts,
    composerSendState,
    nonPersistedComposerImageIds,
    setComposerDraftPrompt,
    setComposerDraftModelSelection,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    addComposerDraftImage,
    addComposerDraftImages,
    removeComposerDraftImage,
    addComposerDraftFile,
    addComposerDraftFiles,
    removeComposerDraftFile,
    insertComposerDraftTerminalContext,
    addComposerDraftTerminalContexts,
    removeComposerDraftTerminalContext,
    setComposerDraftTerminalContexts,
    clearComposerDraftPersistedAttachments,
    syncComposerDraftPersistedAttachments,
    clearComposerDraftContent,
    setDraftThreadContext,
    getDraftThreadByProjectId,
    getDraftThread,
    setProjectDraftThreadId,
    clearProjectDraftThreadId,
    setBootstrapSourceThreadId,
    draftThread,
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
    composerCursor,
    setComposerCursor,
    composerTrigger,
    setComposerTrigger,
    lastInvokedScriptByProjectId,
    setLastInvokedScriptByProjectId,
    composerEditorRef,
    composerFormRef,
    composerImagesRef,
    composerFilesRef,
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
    setPrompt,
    addComposerImage,
    addComposerImagesToDraft,
    addComposerTerminalContextsToDraft,
    removeComposerImageFromDraft,
    addComposerFile,
    addComposerFilesToDraft,
    removeComposerFileFromDraft,
    removeComposerTerminalContextFromDraft,
    fallbackDraftProject,
    localDraftError,
    localDraftThread,
    activeThread,
    runtimeMode,
    interactionMode,
    isServerThread,
    isLocalDraftThread,
    canCheckoutPullRequestIntoThread,
    diffOpen,
    activeThreadId,
    existingOpenTerminalThreadIds,
    activeLatestTurn,
    activeProject,
    activeProjectCwd,
    activeThreadWorktreePath,
    activeTerminalLaunchContext,
    reconcileMountedTerminalThreadIds,
    clampCollapsedComposerCursor,
    collapseExpandedComposerCursor,
    detectComposerTrigger,
    insertInlineTerminalContextPlaceholder,
    randomUUID,
  };
}

export type ChatViewBaseState = ReturnType<typeof useChatViewBaseState>;
