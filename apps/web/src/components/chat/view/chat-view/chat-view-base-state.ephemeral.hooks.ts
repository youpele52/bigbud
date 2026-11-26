import { type ThreadId } from "@bigbud/contracts";
import { useMemo, useRef, useState } from "react";

import { BACKEND_SCOPED_STORAGE_OPTIONS, useLocalStorage } from "~/hooks/useLocalStorage";

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
import { useComposerReadDialogState } from "../../composer/ComposerReadDialog.state";
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
  // Timeline accordion open state lives above the virtualized rows so remounts keep it.
  const [activityAccordionOpenById, setActivityAccordionOpenById] = useState<
    Record<string, boolean>
  >({});
  const [planCardOpen, setPlanCardOpen] = useState(false);
  const [providerUnlocked, setProviderUnlocked] = useState(false);
  const planCardDismissedForTurnRef = useRef<string | null>(null);
  const planCardOpenOnNextThreadRef = useRef(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const { readDocumentDialogOpen, setReadDocumentDialogOpen } =
    useComposerReadDialogState(threadId);
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
    BACKEND_SCOPED_STORAGE_OPTIONS,
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
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);

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
    activityAccordionOpenById,
    setActivityAccordionOpenById,
    planCardOpen,
    setPlanCardOpen,
    providerUnlocked,
    setProviderUnlocked,
    planCardDismissedForTurnRef,
    planCardOpenOnNextThreadRef,
    nowTick,
    setNowTick,
    terminalFocusRequestId,
    setTerminalFocusRequestId,
    composerHighlightedItemId,
    setComposerHighlightedItemId,
    pullRequestDialogState,
    setPullRequestDialogState,
    readDocumentDialogOpen,
    setReadDocumentDialogOpen,
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
    storeSetTerminalOpen,
    storeSplitTerminal,
    storeNewTerminal,
    storeSetActiveTerminal,
    storeCloseTerminal,
    storeServerTerminalLaunchContext,
    storeClearTerminalLaunchContext,
    threads,
    draftThreadsByThreadId,
  };
}
