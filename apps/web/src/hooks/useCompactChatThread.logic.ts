import { type ThreadId } from "@bigbud/contracts";

export const COMPACT_THREAD_STORAGE_KEY = "bigbud:compact-chat:state:v1";

export interface CompactChatPersistedState {
  readonly threadId: ThreadId;
  readonly materialized: boolean;
}

export function parseCompactChatPersistedState(
  raw: string | null,
): CompactChatPersistedState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "threadId" in parsed &&
      typeof parsed.threadId === "string" &&
      parsed.threadId.length > 0
    ) {
      return {
        threadId: parsed.threadId as ThreadId,
        materialized: "materialized" in parsed ? parsed.materialized === true : true,
      };
    }
  } catch {
    // Legacy compact chat stored a bare thread id.
  }
  return { threadId: raw as ThreadId, materialized: true };
}

export function serializeCompactChatPersistedState(state: CompactChatPersistedState): string {
  return JSON.stringify(state);
}

export function shouldAbandonCompactChatThread(input: {
  readonly deleting: boolean;
  readonly presentOnServer: boolean;
  readonly seenOnServer: boolean;
  readonly restoring: boolean;
  readonly persistedMaterialized: boolean;
  readonly hasLocalDraft: boolean;
  readonly hydrationFailed: boolean;
}): boolean {
  if (input.deleting) return true;
  if (input.presentOnServer) return false;
  if (input.seenOnServer) return true;
  if (input.persistedMaterialized && input.hydrationFailed) return true;
  if (!input.restoring) return false;
  if (input.persistedMaterialized) return true;
  return !input.hasLocalDraft;
}
