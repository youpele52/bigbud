import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";

import {
  type MobileComposerDraft,
  type MobileComposerDraftIdentity,
  type MobileDraftThread,
  createMobileComposerDraft,
  forgetMobileComposerDraft,
  forgetMobileComposerDraftsForSession,
  readMobileComposerDraft,
  writeMobileComposerDraft,
} from "./mobileComposerDraft";

export type { MobileComposerDraftIdentity, MobileDraftThread } from "./mobileComposerDraft";
export { makeMobileComposerDraftIdentity } from "./mobileComposerDraft";

export function clearMobileDraftThreads(input: {
  readonly backendBaseUrl: string;
  readonly sessionId: string;
}): boolean {
  return forgetMobileComposerDraftsForSession(input);
}
export function createMobileDraftThread(
  projectId: ProjectId,
  modelSelection: ModelSelection | null = null,
): MobileDraftThread {
  return {
    threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
    projectId,
    createdAt: new Date().toISOString(),
    branch: null,
    worktreePath: null,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    modelSelection,
  };
}

function withNewThread(
  identity: MobileComposerDraftIdentity,
  update: (draft: MobileComposerDraft) => MobileComposerDraft,
): boolean {
  const existing = readMobileComposerDraft(identity).draft;
  const next = update(
    existing ??
      createMobileComposerDraft({
        threadId: ThreadId.makeUnsafe(identity.threadId),
      }),
  );
  return writeMobileComposerDraft(identity, next).ok;
}

export function setMobileDraftThread(
  identity: MobileComposerDraftIdentity,
  draft: MobileDraftThread,
): boolean {
  if (draft.threadId !== identity.threadId) return false;
  return withNewThread(identity, (existing) => ({
    ...existing,
    threadId: draft.threadId,
    newThread: draft,
    modelSelection: draft.modelSelection,
    updatedAt: new Date().toISOString(),
  }));
}

export function getMobileDraftThread(
  identity: MobileComposerDraftIdentity,
): MobileDraftThread | null {
  return readMobileComposerDraft(identity).draft?.newThread ?? null;
}

export function clearMobileDraftThread(identity: MobileComposerDraftIdentity): boolean {
  const existing = readMobileComposerDraft(identity).draft;
  if (!existing?.newThread) return true;
  return writeMobileComposerDraft(identity, {
    ...existing,
    newThread: null,
    updatedAt: new Date().toISOString(),
  }).ok;
}

export function clearMobileDraftStorage(identity: MobileComposerDraftIdentity): boolean {
  return forgetMobileComposerDraft(identity);
}

export { createMobileComposerDraft, readMobileComposerDraft, writeMobileComposerDraft };
