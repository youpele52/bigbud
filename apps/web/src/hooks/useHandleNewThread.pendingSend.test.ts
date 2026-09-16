import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerDraftStore } from "../stores/composer/composer.store";
import { resetComposerDraftStore } from "../stores/composer/composer.store.test.utils";
import {
  beginMaterializationAttempt,
  MATERIALIZATION_LEDGER_KEY,
  readMaterializationLedger,
} from "../stores/materialization/materializationLedger";
import { readOwnershipLedger } from "../stores/ownership/ownershipLedger";
import {
  initializeOwnershipFromComposer,
  reconcileComposerFromOwnershipLedger,
} from "../stores/ownership/ownershipLedger.reconcile";
import { preservePendingSendForNewThread } from "./useHandleNewThread.pendingSend";

const projectId = ProjectId.makeUnsafe("remote-project");
const threadId = ThreadId.makeUnsafe("uncertain-thread");

beforeEach(async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  resetComposerDraftStore();
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(projectId, threadId);
  store.setPrompt(threadId, "Keep my unresolved prompt");
  await initializeOwnershipFromComposer();
});
afterEach(() => vi.unstubAllGlobals());

async function saveAttempt() {
  return beginMaterializationAttempt({
    threadId,
    projectId,
    aggregateKind: "thread",
    aggregateId: threadId,
    commandId: CommandId.makeUnsafe("original-command"),
    messageId: MessageId.makeUnsafe("original-message"),
    kind: "turn",
    createdAt: new Date().toISOString(),
    requestDigest: "sha256:original",
    serverEpoch: "server-1",
    ownershipRevision: 1,
  });
}

describe("New Thread with an unresolved send", () => {
  it("opens an independent draft and preserves the original content and recovery identity", async () => {
    const attempt = await saveAttempt();
    const draft = useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)!;
    const fresh = await preservePendingSendForNewThread(draft);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(threadId);
    const state = useComposerDraftStore.getState();
    expect(state.getDraftThreadByProjectId(projectId)?.threadId).toBe(fresh);
    expect(state.getDraftThread(threadId)).not.toBeNull();
    expect(state.draftsByThreadId[threadId]?.prompt).toBe("Keep my unresolved prompt");
    expect(state.draftsByThreadId[fresh!]?.prompt ?? "").toBe("");
    const ledger = readMaterializationLedger();
    expect(ledger.status === "ready" && ledger.value.attemptsByThreadId[threadId]).toEqual(attempt);
    expect(ledger.status === "ready" && ledger.value.attemptsByThreadId[fresh!]).toBeUndefined();

    // Restoring ownership after a reload retains both drafts and the fresh project binding.
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    reconcileComposerFromOwnershipLedger();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).not.toBeNull();
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      fresh,
    );
  });

  it("reuses the same fresh draft for overlapping New Thread requests", async () => {
    await saveAttempt();
    const draft = useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)!;
    const [first, second] = await Promise.all([
      preservePendingSendForNewThread(draft),
      preservePendingSendForNewThread(draft),
    ]);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(await preservePendingSendForNewThread(draft)).toBe(first);
    expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId)).toHaveLength(2);
  });

  it("continues reusing ordinary unsent drafts", async () => {
    const before = readOwnershipLedger();
    const draft = useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)!;
    expect(await preservePendingSendForNewThread(draft)).toBeNull();
    expect(readOwnershipLedger()).toEqual(before);
  });

  it("preserves all state when the recovery ledger is unreadable", async () => {
    localStorage.setItem(MATERIALIZATION_LEDGER_KEY, "corrupt");
    const before = readOwnershipLedger();
    const draft = useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)!;
    await expect(preservePendingSendForNewThread(draft)).rejects.toThrow("saved send state");
    expect(readOwnershipLedger()).toEqual(before);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );
  });
});
