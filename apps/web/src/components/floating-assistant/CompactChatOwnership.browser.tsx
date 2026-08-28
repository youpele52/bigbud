import "../../index.css";

import { BUILT_IN_CHATS_PROJECT_ID, ProjectId, ThreadId, type NativeApi } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useCompactChatThread } from "~/hooks/useCompactChatThread";
import {
  COMPACT_THREAD_STORAGE_KEY,
  serializeCompactChatPersistedState,
} from "~/hooks/useCompactChatThread.logic";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { __resetNativeApiForTests } from "~/rpc/nativeApi";
import { useComposerDraftStore } from "~/stores/composer";
import { resetComposerDraftStore } from "~/stores/composer/composer.store.test.utils";
import { useStore } from "~/stores/main";

const projectId = ProjectId.makeUnsafe(BUILT_IN_CHATS_PROJECT_ID);
const poisonedThreadId = ThreadId.makeUnsafe("compact-poisoned");

function CompactOwnershipHarness() {
  const compact = useCompactChatThread();
  return (
    <div>
      <span data-testid="thread-id">{compact.threadId}</span>
      <span data-testid="preparing">{String(compact.preparing)}</span>
      <span data-testid="sync-error">{compact.threadSyncError ?? ""}</span>
    </div>
  );
}

function installApi(resolveThreadOwnership: NativeApi["orchestration"]["resolveThreadOwnership"]) {
  window.nativeApi = {
    orchestration: { resolveThreadOwnership },
  } as unknown as NativeApi;
}

describe("compact chat canonical ownership", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetNativeApiForTests();
    resetComposerDraftStore();
    useStore.setState({
      ...useStore.getInitialState(),
      bootstrapComplete: true,
      projects: [
        {
          id: projectId,
          name: "Chats",
          cwd: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-26T00:00:00.000Z",
          updatedAt: "2026-08-26T00:00:00.000Z",
        },
      ],
    });
    localStorage.setItem(
      COMPACT_THREAD_STORAGE_KEY,
      serializeCompactChatPersistedState({
        threadId: poisonedThreadId,
        materialized: false,
      }),
    );
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, poisonedThreadId);
    store.setPrompt(poisonedThreadId, "preserve compact prompt");
  });

  it("moves an archived canonical collision to a fresh compact draft", async () => {
    const resolveThreadOwnership = vi.fn(async () => ({
      threadId: poisonedThreadId,
      projectId,
      status: "archived" as const,
      serverEpoch: "server-1",
      canonicalRevision: 9,
    }));
    installApi(resolveThreadOwnership);

    const mounted = await render(
      <AppAtomRegistryProvider>
        <CompactOwnershipHarness />
      </AppAtomRegistryProvider>,
    );
    try {
      await vi.waitFor(() =>
        expect(page.getByTestId("thread-id").element().textContent).not.toBe(poisonedThreadId),
      );
      const replacementThreadId = ThreadId.makeUnsafe(
        page.getByTestId("thread-id").element().textContent!,
      );
      expect(useComposerDraftStore.getState().getDraftThread(poisonedThreadId)).toBeNull();
      expect(useComposerDraftStore.getState().draftsByThreadId[replacementThreadId]?.prompt).toBe(
        "preserve compact prompt",
      );
      expect(resolveThreadOwnership).toHaveBeenCalledWith({ threadId: poisonedThreadId });
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps an uncertain compact draft gated and intact", async () => {
    installApi(
      vi.fn(async () => ({
        threadId: poisonedThreadId,
        status: "unavailable" as const,
        ownership: "unconfirmed" as const,
        reason: "server unavailable",
      })),
    );

    const mounted = await render(
      <AppAtomRegistryProvider>
        <CompactOwnershipHarness />
      </AppAtomRegistryProvider>,
    );
    try {
      await vi.waitFor(() =>
        expect(page.getByTestId("sync-error").element().textContent).toBe("server unavailable"),
      );
      expect(page.getByTestId("preparing").element().textContent).toBe("true");
      expect(useComposerDraftStore.getState().getDraftThread(poisonedThreadId)).not.toBeNull();
      expect(useComposerDraftStore.getState().draftsByThreadId[poisonedThreadId]?.prompt).toBe(
        "preserve compact prompt",
      );
    } finally {
      await mounted.unmount();
    }
  });
});
