import {
  isExecutionTargetDisconnected,
  useRemoteAccessStore,
} from "../../stores/remoteAccess/remoteAccess.store";
import { fileEditEntries, updateFileEditDraft, type DraftEntry } from "./fileEditDrafts.state";

export const SAVES_PAUSED_MESSAGE =
  "Saves paused: this host is disconnected. Your draft is kept and saves after you connect and the file is re-checked.";

/** Draft keys whose autosave is waiting for the user to Connect the host again. */
const paused = new Set<string>();
let unsubscribe: (() => void) | null = null;

/**
 * A user Disconnect is durable: autosave must not dispatch (and so cannot dial) until Connect.
 * Returns true when the save was paused instead of dispatched.
 */
export function pauseSaveWhileDisconnected(entry: DraftEntry): boolean {
  if (!entry.draft.remote || !isExecutionTargetDisconnected(entry.executionTargetId)) return false;
  paused.add(entry.key);
  watchForConnect();
  if (entry.draft.message !== SAVES_PAUSED_MESSAGE) {
    updateFileEditDraft(entry, {
      ...entry.draft,
      status: "pending",
      message: SAVES_PAUSED_MESSAGE,
    });
  }
  return true;
}

/** After Connect, a paused draft is re-checked against the host before autosave resumes. */
function resumeConnected(): void {
  // Deleting the current key while iterating a Set is safe.
  for (const key of paused) {
    const entry = fileEditEntries.get(key);
    if (!entry) {
      paused.delete(key);
      continue;
    }
    if (isExecutionTargetDisconnected(entry.executionTargetId)) continue;
    paused.delete(key);
    entry.resumeAfterRead = true;
    updateFileEditDraft(entry, {
      ...entry.draft,
      message: null,
      needsVerification: true,
      verificationEpoch: entry.draft.verificationEpoch + 1,
    });
  }
  if (paused.size === 0) {
    unsubscribe?.();
    unsubscribe = null;
  }
}

function watchForConnect(): void {
  unsubscribe ??= useRemoteAccessStore.subscribe(resumeConnected);
}
