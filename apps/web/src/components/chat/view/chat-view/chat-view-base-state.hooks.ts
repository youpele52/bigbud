import { type ThreadId } from "@bigbud/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";

import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
} from "../../../../logic/composer";
import { useSettings } from "../../../../hooks/useSettings";
import { useTheme } from "../../../../hooks/useTheme";
import { insertInlineTerminalContextPlaceholder } from "../../../../lib/terminalContext";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../../../../models/types";
import { useComposerDraftStore, useComposerThreadDraft } from "../../../../stores/composer";
import { useProjectById, useStore, useThreadById } from "../../../../stores/main";
import { useUiStateStore } from "../../../../stores/ui";
import { parseDiffRouteSearch } from "../../../../utils/diff";
import { type ComposerPromptEditorHandle } from "../../composer/ComposerPromptEditor";
import {
  buildLocalDraftThread,
  deriveComposerSendState,
  reconcileMountedTerminalThreadIds,
} from "../ChatView.logic";

import { useServerProviders } from "../../../../rpc/serverState";
import { getDefaultModelSelection } from "../../../../models/provider/provider.models";
import { useChatViewComposerDraftActions } from "./chat-view-base-state.actions.hooks";
import { useChatViewBaseEphemeralState } from "./chat-view-base-state.ephemeral.hooks";

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
  const composerAnnotations = composerDraft.annotations;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        fileCount: composerFiles.length,
        annotationCount: composerAnnotations.length,
        terminalContexts: composerTerminalContexts,
      }),
    [
      composerAnnotations.length,
      composerFiles.length,
      composerImages.length,
      composerTerminalContexts,
      prompt,
    ],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftShellMode = useComposerDraftStore((store) => store.setShellMode);
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
  const setComposerDraftFileWatchForCompletion = useComposerDraftStore(
    (store) => store.setFileWatchForCompletion,
  );
  const addComposerDraftAnnotations = useComposerDraftStore((store) => store.addAnnotations);
  const removeComposerDraftAnnotation = useComposerDraftStore((store) => store.removeAnnotation);
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
  const setComposerReplyTarget = useComposerDraftStore((store) => store.setReplyTarget);
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );

  const ephemeralState = useChatViewBaseEphemeralState({
    threadId,
    prompt,
    composerImages,
    composerFiles,
    composerAnnotations,
    composerTerminalContexts,
  });
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const composerDraftActions = useChatViewComposerDraftActions({
    threadId,
    promptRef: ephemeralState.promptRef,
    composerTerminalContexts,
    setPrompt,
    setComposerDraftShellMode,
    addComposerDraftImage,
    addComposerDraftImages,
    removeComposerDraftImage,
    addComposerDraftFile,
    addComposerDraftFiles,
    removeComposerDraftFile,
    setComposerDraftFileWatchForCompletion,
    addComposerDraftAnnotations,
    removeComposerDraftAnnotation,
    addComposerDraftTerminalContexts,
    removeComposerDraftTerminalContext,
    setComposerCursor,
    setComposerTrigger,
  });

  const fallbackDraftProject = useProjectById(draftThread?.projectId);
  const localDraftError = serverThread
    ? null
    : (ephemeralState.localDraftErrorsByThreadId[threadId] ?? null);
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
    const existingThreadIds = new Set<ThreadId>([
      ...ephemeralState.serverThreadIds,
      ...ephemeralState.draftThreadIds,
    ]);
    return ephemeralState.openTerminalThreadIds.filter((nextThreadId) =>
      existingThreadIds.has(nextThreadId),
    );
  }, [
    ephemeralState.draftThreadIds,
    ephemeralState.openTerminalThreadIds,
    ephemeralState.serverThreadIds,
  ]);
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const activeProject = useProjectById(activeThread?.projectId);
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeTerminalLaunchContext =
    ephemeralState.terminalLaunchContext?.threadId === activeThreadId
      ? ephemeralState.terminalLaunchContext
      : (ephemeralState.storeServerTerminalLaunchContext ?? null);

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
    composerAnnotations,
    composerTerminalContexts,
    composerSendState,
    nonPersistedComposerImageIds,
    setComposerDraftPrompt,
    setComposerDraftShellMode,
    setComposerDraftModelSelection,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    addComposerDraftImage,
    addComposerDraftImages,
    removeComposerDraftImage,
    addComposerDraftFile,
    addComposerDraftFiles,
    removeComposerDraftFile,
    addComposerDraftAnnotations,
    removeComposerDraftAnnotation,
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
    setComposerReplyTarget,
    draftThread,
    ...ephemeralState,
    composerCursor,
    setComposerCursor,
    composerTrigger,
    setComposerTrigger,
    composerEditorRef,
    composerFormRef,
    setPrompt,
    ...composerDraftActions,
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
