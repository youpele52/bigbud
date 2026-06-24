import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type ThreadId as ThreadIdType,
} from "@bigbud/contracts";

const STORAGE_KEY = "bigbud:mobile-draft-threads";

export interface MobileDraftThread {
  readonly threadId: ThreadIdType;
  readonly projectId: ProjectId;
  readonly createdAt: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

function canUseSessionStorage(): boolean {
  return typeof sessionStorage !== "undefined";
}

function readDraftMap(): Record<string, MobileDraftThread> {
  if (!canUseSessionStorage()) {
    return {};
  }
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, MobileDraftThread>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeDraftMap(next: Record<string, MobileDraftThread>) {
  if (!canUseSessionStorage()) {
    return;
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function createMobileDraftThread(projectId: ProjectId): MobileDraftThread {
  return {
    threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
    projectId,
    createdAt: new Date().toISOString(),
    branch: null,
    worktreePath: null,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  };
}

export function setMobileDraftThread(draft: MobileDraftThread) {
  const next = readDraftMap();
  next[draft.threadId] = draft;
  writeDraftMap(next);
}

export function getMobileDraftThread(threadId: ThreadIdType): MobileDraftThread | null {
  return readDraftMap()[threadId] ?? null;
}

export function clearMobileDraftThread(threadId: ThreadIdType) {
  const next = readDraftMap();
  if (!(threadId in next)) {
    return;
  }
  delete next[threadId];
  writeDraftMap(next);
}
