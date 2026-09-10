import {
  ClientOrchestrationCommand,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@bigbud/contracts";
import { Schema } from "effect";

import type { PendingUserInputDraftAnswer } from "~/logic/user-input";

export interface MobileComposerDraftIdentity {
  readonly backendOrigin: string;
  readonly sessionId: string;
  readonly threadId: string;
}

export interface MobileDraftThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly createdAt: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly modelSelection: ModelSelection | null;
}

export type MobileCommandDeliveryStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "uncertain"
  | "reconciling";

export interface MobileSubmittedCommand {
  readonly command: ClientOrchestrationCommand;
  readonly submittedRevision: number;
  readonly submittedAt: string;
  readonly deadlineAt: number;
  readonly status: MobileCommandDeliveryStatus;
  readonly rejectionReason?: "thread_already_exists" | "other";
}

export interface MobileComposerDraft {
  readonly version: 1;
  readonly threadId: ThreadId;
  readonly prompt: string;
  readonly modelSelection: ModelSelection | null;
  readonly newThread: MobileDraftThread | null;
  readonly userInputAnswersByRequestId: Record<string, Record<string, PendingUserInputDraftAnswer>>;
  readonly userInputQuestionIndexByRequestId: Record<string, number>;
  readonly revision: number;
  readonly submitted: MobileSubmittedCommand | null;
  readonly updatedAt: string;
}

const MobileDraftThreadSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  modelSelection: Schema.NullOr(ModelSelection),
});

const MobileDraftAnswerSchema = Schema.Struct({
  selectedOptionKeys: Schema.optional(Schema.Array(Schema.String)),
  selectedOptionIds: Schema.optional(Schema.Array(Schema.String)),
  selectedOptionLabels: Schema.optional(Schema.Array(Schema.String)),
  customAnswer: Schema.optional(Schema.String),
});

const MobileSubmittedCommandSchema = Schema.Struct({
  command: ClientOrchestrationCommand,
  submittedRevision: NonNegativeInt,
  submittedAt: IsoDateTime,
  deadlineAt: Schema.Number,
  status: Schema.Literals(["pending", "accepted", "rejected", "uncertain", "reconciling"]),
  rejectionReason: Schema.optional(Schema.Literals(["thread_already_exists", "other"])),
});

const MobileComposerDraftSchema = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  prompt: Schema.String,
  modelSelection: Schema.NullOr(ModelSelection),
  newThread: Schema.NullOr(MobileDraftThreadSchema),
  userInputAnswersByRequestId: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, MobileDraftAnswerSchema),
  ),
  userInputQuestionIndexByRequestId: Schema.Record(Schema.String, NonNegativeInt),
  revision: NonNegativeInt,
  submitted: Schema.NullOr(MobileSubmittedCommandSchema),
  updatedAt: IsoDateTime,
});

const STORAGE_PREFIX = "bigbud:mobile-composition:v1";
const inMemoryDrafts = new Map<string, MobileComposerDraft>();

export type MobileDraftStorageIssue = "unavailable" | "malformed" | "quota";

export interface MobileDraftReadResult {
  readonly draft: MobileComposerDraft | null;
  readonly issue?: MobileDraftStorageIssue;
}

export interface MobileDraftWriteResult {
  readonly ok: boolean;
  readonly issue?: Exclude<MobileDraftStorageIssue, "malformed">;
}

export function normalizeMobileBackendOrigin(backendBaseUrl: string): string {
  try {
    return new URL(backendBaseUrl).origin;
  } catch {
    return backendBaseUrl.trim().replace(/\/$/, "").toLowerCase();
  }
}

export function makeMobileComposerDraftIdentity(input: {
  readonly backendBaseUrl: string;
  readonly sessionId: string;
  readonly threadId: string;
}): MobileComposerDraftIdentity {
  return {
    backendOrigin: normalizeMobileBackendOrigin(input.backendBaseUrl),
    sessionId: input.sessionId,
    threadId: input.threadId,
  };
}

function storageKey(identity: MobileComposerDraftIdentity): string {
  return [STORAGE_PREFIX, identity.backendOrigin, identity.sessionId, identity.threadId]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function getStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

export function createMobileComposerDraft(input: {
  readonly threadId: ThreadId;
  readonly newThread?: MobileDraftThread | null;
  readonly modelSelection?: ModelSelection | null;
  readonly prompt?: string;
}): MobileComposerDraft {
  return {
    version: 1,
    threadId: input.threadId,
    prompt: input.prompt ?? "",
    modelSelection: input.modelSelection ?? input.newThread?.modelSelection ?? null,
    newThread: input.newThread ?? null,
    userInputAnswersByRequestId: {},
    userInputQuestionIndexByRequestId: {},
    revision: 0,
    submitted: null,
    updatedAt: new Date().toISOString(),
  };
}

export function readMobileComposerDraft(
  identity: MobileComposerDraftIdentity,
): MobileDraftReadResult {
  const key = storageKey(identity);
  const memoryDraft = inMemoryDrafts.get(key);
  if (memoryDraft) return { draft: memoryDraft };
  const storage = getStorage();
  if (!storage) return { draft: null, issue: "unavailable" };
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { draft: null, issue: "unavailable" };
  }
  if (raw === null) return { draft: null };
  try {
    const decode = Schema.decodeUnknownSync(MobileComposerDraftSchema as never) as (
      value: unknown,
    ) => MobileComposerDraft;
    const draft = decode(JSON.parse(raw));
    return draft.threadId === identity.threadId
      ? { draft: draft as MobileComposerDraft }
      : { draft: null, issue: "malformed" };
  } catch {
    return { draft: null, issue: "malformed" };
  }
}

export function writeMobileComposerDraft(
  identity: MobileComposerDraftIdentity,
  draft: MobileComposerDraft,
): MobileDraftWriteResult {
  const key = storageKey(identity);
  const storage = getStorage();
  if (!storage) {
    inMemoryDrafts.set(key, draft);
    return { ok: false, issue: "unavailable" };
  }
  try {
    storage.setItem(key, JSON.stringify(draft));
    inMemoryDrafts.delete(key);
    return { ok: true };
  } catch (error) {
    inMemoryDrafts.set(key, draft);
    return { ok: false, issue: isQuotaError(error) ? "quota" : "unavailable" };
  }
}

export function forgetMobileComposerDraft(identity: MobileComposerDraftIdentity): boolean {
  inMemoryDrafts.delete(storageKey(identity));
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.removeItem(storageKey(identity));
    return true;
  } catch {
    return false;
  }
}

export function forgetMobileComposerDraftsForSession(input: {
  readonly backendBaseUrl: string;
  readonly sessionId: string;
}): boolean {
  const prefix = [
    STORAGE_PREFIX,
    normalizeMobileBackendOrigin(input.backendBaseUrl),
    input.sessionId,
  ]
    .map((part) => encodeURIComponent(part))
    .join(":");
  for (const key of inMemoryDrafts.keys()) {
    if (key.startsWith(`${prefix}:`)) inMemoryDrafts.delete(key);
  }
  const storage = getStorage();
  if (!storage) return false;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => key !== null && key.startsWith(`${prefix}:`),
    );
    for (const key of keys) {
      storage.removeItem(key);
      inMemoryDrafts.delete(key);
    }
    return true;
  } catch {
    return false;
  }
}

export function advanceMobileComposerDraft(
  draft: MobileComposerDraft,
  update: Omit<Partial<MobileComposerDraft>, "version" | "threadId" | "revision" | "updatedAt">,
): MobileComposerDraft {
  return {
    ...draft,
    ...update,
    revision: draft.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

export function clearSubmittedMobileComposerDraftIfRevision(
  draft: MobileComposerDraft,
  submittedRevision: number,
): MobileComposerDraft {
  return draft.revision === submittedRevision &&
    draft.submitted?.submittedRevision === submittedRevision
    ? advanceMobileComposerDraft(draft, { prompt: "", submitted: null })
    : draft;
}

export const MOBILE_COMPOSER_DEFAULTS = {
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
} as const;
