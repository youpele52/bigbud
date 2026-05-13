import type { ThreadId } from "@bigbud/contracts";
import {
  type ModelSelection,
  PROVIDER_KINDS,
  type ProviderKind,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
} from "@bigbud/contracts";
import { ensureInlineTerminalContextPlaceholders } from "../../lib/terminalContext";
import {
  type DraftThreadEnvMode,
  type LegacyPersistedComposerThreadDraftState,
  type ComposerAnnotationAttachment,
  type PersistedComposerDraftStoreState,
  type PersistedComposerImageAttachment,
  type PersistedComposerThreadDraftState,
  type PersistedDraftThreadState,
  type PersistedTerminalContextDraft,
} from "./types.store";
import {
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  normalizeModelSelection,
  normalizeProviderKind,
  normalizeProviderModelOptions,
} from "./normalization.store";
import { DeepMutable } from "effect/Types";

function isRuntimeMode(value: unknown): value is import("@bigbud/contracts").RuntimeMode {
  return value === "approval-required" || value === "auto-accept-edits" || value === "full-access";
}

export function normalizeModelSelectionByProvider(
  value: unknown,
): Partial<Record<ProviderKind, ModelSelection>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as Record<string, unknown>;
  const selections: Partial<Record<ProviderKind, ModelSelection>> = {};
  for (const provider of PROVIDER_KINDS) {
    const selection = normalizeModelSelection(candidate[provider], { provider });
    if (selection?.provider === provider) {
      selections[provider] = selection;
    }
  }
  return selections;
}

// ── Persisted-value normalizers ───────────────────────────────────────

export function normalizePersistedAttachment(
  value: unknown,
): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
  };
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizePersistedAnnotation(value: unknown): ComposerAnnotationAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const page = candidate.page;
  const element = candidate.element;
  const viewport = candidate.viewport;
  if (!page || typeof page !== "object") return null;
  if (!element || typeof element !== "object") return null;
  if (!viewport || typeof viewport !== "object") return null;

  const pageCandidate = page as Record<string, unknown>;
  const elementCandidate = element as Record<string, unknown>;
  const viewportCandidate = viewport as Record<string, unknown>;
  const rect = elementCandidate.rect;
  if (!rect || typeof rect !== "object") return null;
  const rectCandidate = rect as Record<string, unknown>;
  const id = candidate.id;
  const imageId = candidate.imageId;
  const comment = candidate.comment;
  const createdAt = candidate.createdAt;
  const url = pageCandidate.url;
  const title = pageCandidate.title;
  const selector = elementCandidate.selector;
  const tag = elementCandidate.tag;
  const role = elementCandidate.role;
  const text = elementCandidate.text;
  const className = elementCandidate.className;
  const rectX = normalizeFiniteNumber(rectCandidate.x);
  const rectY = normalizeFiniteNumber(rectCandidate.y);
  const rectWidth = normalizeFiniteNumber(rectCandidate.width);
  const rectHeight = normalizeFiniteNumber(rectCandidate.height);
  const viewportWidth = normalizeFiniteNumber(viewportCandidate.width);
  const viewportHeight = normalizeFiniteNumber(viewportCandidate.height);
  const devicePixelRatio = normalizeFiniteNumber(viewportCandidate.devicePixelRatio);
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof imageId !== "string" ||
    imageId.length === 0 ||
    typeof comment !== "string" ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof url !== "string" ||
    typeof title !== "string" ||
    typeof selector !== "string" ||
    typeof tag !== "string" ||
    typeof role !== "string" ||
    typeof text !== "string" ||
    typeof className !== "string" ||
    rectX === null ||
    rectY === null ||
    rectWidth === null ||
    rectHeight === null ||
    viewportWidth === null ||
    viewportHeight === null ||
    devicePixelRatio === null
  ) {
    return null;
  }
  const ariaLabel = elementCandidate.ariaLabel;
  const elementId = elementCandidate.id;
  return {
    id,
    imageId,
    comment,
    page: { url, title },
    element: {
      selector,
      tag,
      role,
      text,
      ariaLabel: typeof ariaLabel === "string" ? ariaLabel : null,
      id: typeof elementId === "string" ? elementId : null,
      className,
      rect: { x: rectX, y: rectY, width: rectWidth, height: rectHeight },
    },
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      devicePixelRatio,
    },
    createdAt,
  };
}

export function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id,
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  };
}

export function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

export function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByProjectId: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadId" | "projectDraftThreadIdByProjectId"
> {
  const draftThreadsByThreadId: Record<ThreadId, PersistedDraftThreadState> = {};
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        continue;
      }
      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const projectId = candidateDraftThread.projectId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      if (typeof projectId !== "string" || projectId.length === 0) {
        continue;
      }
      draftThreadsByThreadId[threadId as ThreadId] = {
        projectId: projectId as import("@bigbud/contracts").ProjectId,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode: isRuntimeMode(candidateDraftThread.runtimeMode)
          ? candidateDraftThread.runtimeMode
          : DEFAULT_RUNTIME_MODE,
        interactionMode:
          candidateDraftThread.interactionMode === "plan" ||
          candidateDraftThread.interactionMode === "default"
            ? candidateDraftThread.interactionMode
            : DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: typeof branch === "string" ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
      };
    }
  }

  const projectDraftThreadIdByProjectId: Record<import("@bigbud/contracts").ProjectId, ThreadId> =
    {};
  if (
    rawProjectDraftThreadIdByProjectId &&
    typeof rawProjectDraftThreadIdByProjectId === "object"
  ) {
    for (const [projectId, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectId as Record<string, unknown>,
    )) {
      if (
        typeof projectId === "string" &&
        projectId.length > 0 &&
        typeof threadId === "string" &&
        threadId.length > 0
      ) {
        projectDraftThreadIdByProjectId[projectId as import("@bigbud/contracts").ProjectId] =
          threadId as ThreadId;
        if (!draftThreadsByThreadId[threadId as ThreadId]) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            projectId: projectId as import("@bigbud/contracts").ProjectId,
            createdAt: new Date().toISOString(),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            envMode: "local",
          };
        } else if (draftThreadsByThreadId[threadId as ThreadId]?.projectId !== projectId) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            ...draftThreadsByThreadId[threadId as ThreadId]!,
            projectId: projectId as import("@bigbud/contracts").ProjectId,
          };
        }
      }
    }
  }

  return { draftThreadsByThreadId, projectDraftThreadIdByProjectId };
}

export function normalizePersistedDraftsByThreadId(
  rawDraftMap: unknown,
): PersistedComposerDraftStoreState["draftsByThreadId"] {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {};
  }

  const nextDraftsByThreadId: DeepMutable<PersistedComposerDraftStoreState["draftsByThreadId"]> =
    {};
  for (const [threadId, draftValue] of Object.entries(rawDraftMap as Record<string, unknown>)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as PersistedComposerThreadDraftState;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const shellMode = draftCandidate.shellMode === true;
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const annotations = Array.isArray(draftCandidate.annotations)
      ? draftCandidate.annotations.flatMap((entry) => {
          const normalized = normalizePersistedAnnotation(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const runtimeMode = isRuntimeMode(draftCandidate.runtimeMode)
      ? draftCandidate.runtimeMode
      : null;
    const interactionMode =
      draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
        ? draftCandidate.interactionMode
        : null;
    const bootstrapSourceThreadId =
      typeof draftCandidate.bootstrapSourceThreadId === "string" &&
      draftCandidate.bootstrapSourceThreadId.length > 0
        ? (draftCandidate.bootstrapSourceThreadId as ThreadId)
        : null;
    const prompt = ensureInlineTerminalContextPlaceholders(
      promptCandidate,
      terminalContexts.length,
    );
    // If the draft already has the v3 shape, use it directly
    const legacyDraftCandidate = draftValue as LegacyPersistedComposerThreadDraftState;
    let modelSelectionByProvider: Partial<
      Record<import("@bigbud/contracts").ProviderKind, ModelSelection>
    > = {};
    let activeProvider: import("@bigbud/contracts").ProviderKind | null = null;

    if (
      draftCandidate.modelSelectionByProvider &&
      typeof draftCandidate.modelSelectionByProvider === "object"
    ) {
      // v3 format
      modelSelectionByProvider = normalizeModelSelectionByProvider(
        draftCandidate.modelSelectionByProvider,
      );
      activeProvider = normalizeProviderKind(draftCandidate.activeProvider);
    } else {
      // v2 or legacy format: migrate
      const normalizedModelOptions =
        normalizeProviderModelOptions(
          legacyDraftCandidate.modelOptions,
          undefined,
          legacyDraftCandidate,
        ) ?? null;
      const normalizedModelSelection = normalizeModelSelection(
        legacyDraftCandidate.modelSelection,
        {
          provider: legacyDraftCandidate.provider,
          model: legacyDraftCandidate.model,
          modelOptions: normalizedModelOptions ?? legacyDraftCandidate.modelOptions,
          legacyCodex: legacyDraftCandidate,
        },
      );
      const mergedModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
        normalizedModelSelection,
        normalizedModelOptions,
      );
      const modelSelection = legacySyncModelSelectionOptions(
        normalizedModelSelection,
        mergedModelOptions,
      );
      modelSelectionByProvider = legacyToModelSelectionByProvider(
        modelSelection,
        mergedModelOptions,
      );
      activeProvider = modelSelection?.provider ?? null;
    }

    const hasModelData =
      Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;
    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      annotations.length === 0 &&
      terminalContexts.length === 0 &&
      !hasModelData &&
      !runtimeMode &&
      !interactionMode &&
      bootstrapSourceThreadId === null
    ) {
      continue;
    }
    nextDraftsByThreadId[threadId as ThreadId] = {
      prompt,
      shellMode,
      attachments,
      ...(annotations.length > 0 ? { annotations } : {}),
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(hasModelData ? { modelSelectionByProvider, activeProvider } : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
      ...(bootstrapSourceThreadId !== null ? { bootstrapSourceThreadId } : {}),
    };
  }

  return nextDraftsByThreadId;
}
