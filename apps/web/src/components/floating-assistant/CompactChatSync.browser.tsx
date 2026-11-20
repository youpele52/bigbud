import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useCompactChatThread } from "../../hooks/useCompactChatThread";
import {
  COMPACT_THREAD_STORAGE_KEY,
  serializeCompactChatPersistedState,
} from "../../hooks/useCompactChatThread.logic";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useComposerDraftStore } from "../../stores/composer";
import {
  makeImage,
  resetComposerDraftStore,
} from "../../stores/composer/composer.store.test.utils";
import { deferred, installSendApi } from "../chat/view/ChatView.sendTurn.browser-helpers";
import { recentId, resetProjectGateStore } from "../chat/view/ThreadProjectGate.test-helpers";
import { resetWsConnectionStateForTests } from "../../rpc/wsConnectionState";

const state: { compact: ReturnType<typeof useCompactChatThread> | null } = { compact: null };
function Harness() {
  state.compact = useCompactChatThread();
  return <span>Compact</span>;
}
let mounted: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  localStorage.clear();
  resetProjectGateStore();
  resetComposerDraftStore();
  resetWsConnectionStateForTests();
  state.compact = null;
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it("does not erase text, images or files entered during materialized-thread synchronization", async () => {
  const api = await installSendApi();
  localStorage.setItem(
    COMPACT_THREAD_STORAGE_KEY,
    serializeCompactChatPersistedState({ threadId: recentId, materialized: true }),
  );
  mounted = await render(
    <AppAtomRegistryProvider>
      <Harness />
    </AppAtomRegistryProvider>,
  );
  await vi.waitFor(() => expect(state.compact?.preparing).toBe(false));
  const detail = api.orchestration.getSelectedThreadDetail;
  const result = await detail({ threadId: recentId });
  const pending = deferred<typeof result>();
  detail.mockReturnValue(pending.promise);
  const synchronizing = state.compact!.synchronizeMaterializedThread(recentId);
  const drafts = useComposerDraftStore.getState();
  drafts.setPrompt(recentId, "A new compact draft");
  drafts.addImage(
    recentId,
    makeImage({ id: "new-screenshot", previewUrl: "data:image/png;base64,AQ==" }),
  );
  drafts.addFile(recentId, {
    type: "file",
    id: "new-file",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    filePath: "",
    file: new File(["data"], "notes.txt"),
  });
  pending.resolve(result);
  await synchronizing;
  expect(state.compact!.threadSyncError).toBeNull();
  expect(useComposerDraftStore.getState().draftsByThreadId[recentId]).toMatchObject({
    prompt: "A new compact draft",
    images: [{ id: "new-screenshot" }],
    files: [{ id: "new-file" }],
  });
  expect(JSON.parse(localStorage.getItem(COMPACT_THREAD_STORAGE_KEY)!).threadId).toBe(recentId);
});
