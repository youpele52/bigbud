import type {
  ApprovalRequestId,
  ModelSelection,
  ProviderInteractionMode,
  ProviderKind,
  RuntimeMode,
  ServerProvider,
  ThreadId,
} from "@bigbud/contracts";
import type { ComposerTrigger } from "../../../logic/composer";
import type { PendingUserInput } from "../../../logic/session";
import type { TerminalContextDraft } from "../../../lib/terminalContext";
import type { ChatMessage, Project, ProposedPlan, Thread } from "../../../models/types";
import type {
  ComposerAnnotationAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../../../stores/composer";

export interface UseOnSendInput {
  activeThread: Thread | undefined;
  activeProject: Project | undefined;
  activeThreadId: ThreadId | null;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  sendInFlightRef: React.MutableRefObject<boolean>;
  promptRef: React.MutableRefObject<string>;
  composerImages: ComposerImageAttachment[];
  composerImagesRef: React.MutableRefObject<ComposerImageAttachment[]>;
  composerFiles: ComposerFileAttachment[];
  composerFilesRef: React.MutableRefObject<ComposerFileAttachment[]>;
  composerAnnotations: ComposerAnnotationAttachment[];
  composerAnnotationsRef: React.MutableRefObject<ComposerAnnotationAttachment[]>;
  composerTerminalContexts: TerminalContextDraft[];
  composerTerminalContextsRef: React.MutableRefObject<TerminalContextDraft[]>;
  selectedProvider: ProviderKind;
  selectedModel: string;
  selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  selectedPromptEffort: string | null;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  isComposerShellMode: boolean;
  envMode: string;
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: ProposedPlan | null;
  isOpencodePendingUserInputMode: boolean;
  activePendingUserInputRequestId: ApprovalRequestId | null;
  activePendingUserInput: PendingUserInput | null;
  shouldAutoScrollRef: React.MutableRefObject<boolean>;
  setOptimisticUserMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setPrompt: (prompt: string) => void;
  setComposerShellMode: (shellMode: boolean) => void;
  setComposerCursor: React.Dispatch<React.SetStateAction<number>>;
  setComposerTrigger: React.Dispatch<React.SetStateAction<ComposerTrigger | null>>;
  setComposerHighlightedItemId: React.Dispatch<React.SetStateAction<string | null>>;
  setThreadError: (targetThreadId: ThreadId | null, error: string | null) => void;
  setStoreThreadError: (threadId: ThreadId, error: string | null) => void;
  addComposerImagesToDraft: (images: ComposerImageAttachment[]) => void;
  addComposerFilesToDraft: (files: ComposerFileAttachment[]) => void;
  addComposerAnnotationsToDraft: (annotations: ComposerAnnotationAttachment[]) => void;
  addComposerTerminalContextsToDraft: (contexts: TerminalContextDraft[]) => void;
  clearComposerDraftContent: (threadId: ThreadId) => void;
  bootstrapSourceThreadId: ThreadId | null;
  clearBootstrapSourceThreadId: (threadId: ThreadId) => void;
  replyTarget: ChatMessage["replyTo"] | null;
  setReplyTarget: (threadId: ThreadId, replyTarget: ChatMessage["replyTo"] | null) => void;
  beginLocalDispatch: (opts: { preparingWorktree: boolean }) => void;
  resetLocalDispatch: () => void;
  forceStickToBottom: () => void;
  persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    modelSelection?: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<void>;
  onSubmitPlanFollowUp: (input: {
    text: string;
    interactionMode: ProviderInteractionMode;
  }) => Promise<void>;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onRespondToUserInput: (
    requestId: ApprovalRequestId,
    answers: Record<string, unknown>,
  ) => Promise<void>;
}
