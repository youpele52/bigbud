import {
  CODEX_REASONING_EFFORT_OPTIONS,
  COMPOSER_DRAFT_LEGACY_STORAGE_KEYS,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  ProviderKind,
  ProviderModelOptions,
  RuntimeMode,
  ThreadId,
} from "@bigbud/contracts";
import * as Schema from "effect/Schema";
import { type TerminalContextDraft } from "../../lib/terminalContext";
import { type ChatImageAttachment, type ChatFileAttachment } from "../../models/types";

export {
  COMPOSER_DRAFT_LEGACY_STORAGE_KEYS,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
};
export const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

export const ComposerAnnotationElement = Schema.Struct({
  selector: Schema.String,
  tag: Schema.String,
  role: Schema.String,
  text: Schema.String,
  ariaLabel: Schema.NullOr(Schema.String),
  id: Schema.NullOr(Schema.String),
  className: Schema.String,
  rect: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
});

export const ComposerAnnotationViewport = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  devicePixelRatio: Schema.Number,
});

export const ComposerAnnotationAttachment = Schema.Struct({
  id: Schema.String,
  imageId: Schema.String,
  comment: Schema.String,
  page: Schema.Struct({
    url: Schema.String,
    title: Schema.String,
  }),
  element: ComposerAnnotationElement,
  viewport: ComposerAnnotationViewport,
  createdAt: Schema.String,
});
export type ComposerAnnotationAttachment = typeof ComposerAnnotationAttachment.Type;

/** In-memory representation of a non-image file attachment. Holds only the path — no bytes. */
export interface ComposerFileAttachment extends ChatFileAttachment {
  /** Absolute filesystem path — available on desktop (Electron). On web, this is empty string. */
  filePath: string;
  /** The original File object — used on web fallback (base64 transport). Null on desktop. */
  file: File | null;
}

export const PersistedComposerFileAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  filePath: Schema.String,
});

export const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
});
export type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

export type PersistedComposerFileAttachment = typeof PersistedComposerFileAttachment.Type;

export const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  fileAttachments: Schema.optionalKey(Schema.Array(PersistedComposerFileAttachment)),
  annotations: Schema.optionalKey(Schema.Array(ComposerAnnotationAttachment)),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  modelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  bootstrapSourceThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
});
export type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

export const LegacyCodexFields = Schema.Struct({
  effort: Schema.optionalKey(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  codexFastMode: Schema.optionalKey(Schema.Boolean),
  serviceTier: Schema.optionalKey(Schema.String),
});
export type LegacyCodexFields = typeof LegacyCodexFields.Type;

export const LegacyThreadModelFields = Schema.Struct({
  provider: Schema.optionalKey(ProviderKind),
  model: Schema.optionalKey(Schema.String),
  modelOptions: Schema.optionalKey(Schema.NullOr(ProviderModelOptions)),
});
export type LegacyThreadModelFields = typeof LegacyThreadModelFields.Type;

export type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: ProviderModelOptions | null;
};

export type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields;

export const LegacyStickyModelFields = Schema.Struct({
  stickyProvider: Schema.optionalKey(ProviderKind),
  stickyModel: Schema.optionalKey(Schema.String),
  stickyModelOptions: Schema.optionalKey(Schema.NullOr(ProviderModelOptions)),
});
export type LegacyStickyModelFields = typeof LegacyStickyModelFields.Type;

export type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: ProviderModelOptions | null;
};

export type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

export const PersistedDraftThreadState = Schema.Struct({
  projectId: ProjectId,
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  envMode: DraftThreadEnvModeSchema,
});
export type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type;

export const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadId: Schema.Record(ThreadId, PersistedComposerThreadDraftState),
  draftThreadsByThreadId: Schema.Record(ThreadId, PersistedDraftThreadState),
  projectDraftThreadIdByProjectId: Schema.Record(ProjectId, ThreadId),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
});
export type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

export const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  annotations: ComposerAnnotationAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  persistedFileAttachments: PersistedComposerFileAttachment[];
  terminalContexts: TerminalContextDraft[];
  modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  activeProvider: ProviderKind | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
  bootstrapSourceThreadId: ThreadId | null;
}

export interface DraftThreadState {
  projectId: ProjectId;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
}

export interface ProjectDraftThread extends DraftThreadState {
  threadId: ThreadId;
}

export interface ComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  projectDraftThreadIdByProjectId: Record<ProjectId, ThreadId>;
  stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  stickyActiveProvider: ProviderKind | null;
  getDraftThreadByProjectId: (projectId: ProjectId) => ProjectDraftThread | null;
  getDraftThread: (threadId: ThreadId) => DraftThreadState | null;
  setProjectDraftThreadId: (
    projectId: ProjectId,
    threadId: ThreadId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectId?: ProjectId;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  clearDraftThread: (threadId: ThreadId) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  setTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadId: ThreadId,
    modelSelection: ModelSelection | null | undefined,
  ) => void;
  setModelOptions: (
    threadId: ThreadId,
    modelOptions: ProviderModelOptions | null | undefined,
  ) => void;
  applyStickyState: (threadId: ThreadId) => void;
  setProviderModelOptions: (
    threadId: ThreadId,
    provider: ProviderKind,
    nextProviderOptions: ProviderModelOptions[ProviderKind] | null | undefined,
    options?: {
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (threadId: ThreadId, runtimeMode: RuntimeMode | null | undefined) => void;
  setInteractionMode: (
    threadId: ThreadId,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  addImage: (threadId: ThreadId, image: ComposerImageAttachment) => void;
  addImages: (threadId: ThreadId, images: ComposerImageAttachment[]) => void;
  removeImage: (threadId: ThreadId, imageId: string) => void;
  addFile: (threadId: ThreadId, file: ComposerFileAttachment) => void;
  addFiles: (threadId: ThreadId, files: ComposerFileAttachment[]) => void;
  removeFile: (threadId: ThreadId, fileId: string) => void;
  addAnnotation: (threadId: ThreadId, annotation: ComposerAnnotationAttachment) => void;
  addAnnotations: (threadId: ThreadId, annotations: ComposerAnnotationAttachment[]) => void;
  removeAnnotation: (threadId: ThreadId, annotationId: string) => void;
  insertTerminalContext: (
    threadId: ThreadId,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadId: ThreadId, context: TerminalContextDraft) => void;
  addTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (threadId: ThreadId, contextId: string) => void;
  clearTerminalContexts: (threadId: ThreadId) => void;
  clearPersistedAttachments: (threadId: ThreadId) => void;
  syncPersistedAttachments: (
    threadId: ThreadId,
    attachments: PersistedComposerImageAttachment[],
  ) => void;
  clearComposerContent: (threadId: ThreadId) => void;
  setBootstrapSourceThreadId: (
    threadId: ThreadId,
    sourceThreadId: ThreadId | null | undefined,
  ) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderModelOptions | null;
}

/** Frozen sentinel — use as the default for threads with no draft. */
export const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: Object.freeze([]) as unknown as ComposerImageAttachment[],
  files: Object.freeze([]) as unknown as ComposerFileAttachment[],
  annotations: Object.freeze([]) as unknown as ComposerAnnotationAttachment[],
  nonPersistedImageIds: Object.freeze([]) as unknown as string[],
  persistedAttachments: Object.freeze([]) as unknown as PersistedComposerImageAttachment[],
  persistedFileAttachments: Object.freeze([]) as unknown as PersistedComposerFileAttachment[],
  terminalContexts: Object.freeze([]) as unknown as TerminalContextDraft[],
  modelSelectionByProvider: Object.freeze({}) as Partial<Record<ProviderKind, ModelSelection>>,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
  bootstrapSourceThreadId: null,
});

export const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadId: {},
  draftThreadsByThreadId: {},
  projectDraftThreadIdByProjectId: {},
  stickyModelSelectionByProvider: {},
  stickyActiveProvider: null,
});
