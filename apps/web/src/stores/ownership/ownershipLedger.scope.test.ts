import { ProjectId, ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useComposerDraftStore } from "../composer";
import { makeImage, resetComposerDraftStore } from "../composer/composer.store.test.utils";
import { applyOwnershipLedgerToComposer } from "./ownershipLedger.composer";
import { findOwnershipReplacement } from "./ownershipLedger.replacements";
import {
  emptyOwnershipLedger,
  initializeOwnershipLedger,
  readOwnershipLedger,
  registerDraftOwnership,
  replaceCollidingDraftOwnership,
} from "./ownershipLedger";

const projectId = ProjectId.makeUnsafe("scope-project");
const mainThreadId = ThreadId.makeUnsafe("scope-main-thread");
const compactThreadId = ThreadId.makeUnsafe("scope-compact-thread");

const mainDraft = {
  projectId,
  createdAt: "2026-08-27T00:00:00.000Z",
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: "main",
  worktreePath: null,
  envMode: "local" as const,
};

const compactDraft = {
  ...mainDraft,
  createdAt: "2026-08-27T00:01:00.000Z",
  branch: "compact",
};

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("ownership ledger scopes", () => {
  beforeEach(() => resetComposerDraftStore());

  it("initializes main and compact drafts without cross-surface overwrites", async () => {
    const storage = createStorage();
    const mainLedger = await initializeOwnershipLedger({
      scope: "main",
      draftsByThreadId: { [mainThreadId]: mainDraft },
      projectDraftThreadIdByProjectId: { [projectId]: mainThreadId },
      options: { storage, lockManager: null },
    });
    const ledger = await initializeOwnershipLedger({
      scope: "compact",
      draftsByThreadId: { [compactThreadId]: compactDraft },
      projectDraftThreadIdByProjectId: { [projectId]: compactThreadId },
      options: { storage, lockManager: null },
    });

    expect(ledger.scopes.main.draftsByThreadId[mainThreadId]?.branch).toBe("main");
    expect(ledger.scopes.compact.draftsByThreadId[compactThreadId]?.branch).toBe("compact");
    expect(ledger.scopes.main.projectBindingsByProjectId[projectId]?.threadId).toBe(mainThreadId);
    expect(ledger.scopes.compact.projectBindingsByProjectId[projectId]?.threadId).toBe(
      compactThreadId,
    );

    applyOwnershipLedgerToComposer(mainLedger, "main");
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      mainThreadId,
    );
    applyOwnershipLedgerToComposer(ledger, "compact");
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      compactThreadId,
    );
    expect(ledger.scopes.main.projectBindingsByProjectId[projectId]?.threadId).toBe(mainThreadId);
  });

  it("registers a draft in only the requested surface", async () => {
    const storage = createStorage();
    await initializeOwnershipLedger({
      scope: "main",
      draftsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      options: { storage, lockManager: null },
    });
    await initializeOwnershipLedger({
      scope: "compact",
      draftsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      options: { storage, lockManager: null },
    });
    await registerDraftOwnership({
      scope: "compact",
      threadId: compactThreadId,
      draft: compactDraft,
      bindProject: true,
      options: { storage, lockManager: null },
    });

    const result = readOwnershipLedger(storage);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.value.scopes.main.draftsByThreadId).toEqual({});
    expect(result.value.scopes.compact.draftsByThreadId[compactThreadId]?.branch).toBe("compact");
  });

  it.each(["main", "compact"] as const)(
    "recovers missed replacement revisions in %s",
    async (scope) => {
      const storage = createStorage();
      const options = { storage, lockManager: null };
      const finalId = ThreadId.makeUnsafe("scope-final-thread");
      const before = await initializeOwnershipLedger({
        scope,
        draftsByThreadId: { [mainThreadId]: mainDraft },
        projectDraftThreadIdByProjectId: { [projectId]: mainThreadId },
        options,
      });
      applyOwnershipLedgerToComposer(before, scope);
      useComposerDraftStore.getState().setPrompt(mainThreadId, "delayed draft");
      useComposerDraftStore.getState().addImage(
        mainThreadId,
        makeImage({
          id: "delayed-screenshot",
          previewUrl: "data:image/jpeg;base64,anBlZw==",
        }),
      );
      const replace = (threadId: ThreadId, nextId: ThreadId) =>
        replaceCollidingDraftOwnership({
          scope,
          threadId,
          status: "archived",
          serverEpoch: "server-1",
          canonicalRevision: 9,
          invalidatedAt: "2026-08-27T01:00:00.000Z",
          createThreadId: () => nextId,
          options,
        });
      await replace(mainThreadId, compactThreadId);
      await replace(compactThreadId, finalId);
      const persisted = readOwnershipLedger(storage);
      expect(persisted.status).toBe("ready");
      if (persisted.status !== "ready") return;
      applyOwnershipLedgerToComposer(persisted.value, scope);
      expect(useComposerDraftStore.getState().draftsByThreadId[mainThreadId]).toBeUndefined();
      expect(useComposerDraftStore.getState().draftsByThreadId[finalId]).toMatchObject({
        prompt: "delayed draft",
        images: [{ id: "delayed-screenshot" }],
      });
      expect(
        (await replace(mainThreadId, ThreadId.makeUnsafe("unused"))).replacement.threadId,
      ).toBe(finalId);
      expect(
        findOwnershipReplacement(
          persisted.value,
          mainThreadId,
          scope === "main" ? "compact" : "main",
        ),
      ).toBeUndefined();
      const cyclic = {
        ...persisted.value,
        invalidationsByThreadId: {
          ...persisted.value.invalidationsByThreadId,
          [compactThreadId]: {
            ...persisted.value.invalidationsByThreadId[compactThreadId]!,
            replacementThreadIdByScope: { [scope]: mainThreadId },
          },
        },
      };
      expect(findOwnershipReplacement(cyclic, mainThreadId, scope)).toBeUndefined();
    },
  );

  it("migrates an unscoped ledger into the main scope", () => {
    const storage = createStorage();
    const empty = emptyOwnershipLedger();
    storage.setItem(
      "bigbud:draft-ownership-ledger:v1",
      JSON.stringify({
        version: empty.version,
        lastMutationId: empty.lastMutationId,
        nextGeneration: empty.nextGeneration,
        invalidatedThroughGeneration: empty.invalidatedThroughGeneration,
        invalidationsByThreadId: empty.invalidationsByThreadId,
        draftsByThreadId: {
          [mainThreadId]: { threadId: mainThreadId, generation: 1, ...mainDraft },
        },
        projectBindingsByProjectId: {
          [projectId]: { projectId, threadId: mainThreadId, generation: 1 },
        },
        revision: 3,
      }),
    );

    const result = readOwnershipLedger(storage);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.value.scopes.main.draftsByThreadId[mainThreadId]?.branch).toBe("main");
    expect(result.value.initializedScopes).toEqual({ main: true, compact: false });
    expect(result.value.scopes.compact.draftsByThreadId).toEqual({});
  });

  it.each(["main", "compact"] as const)(
    "replaces a %s collision with a fresh record identity and generation",
    async (scope) => {
      const storage = createStorage();
      const options = { storage, lockManager: null };
      const before = await initializeOwnershipLedger({
        scope,
        draftsByThreadId: { [mainThreadId]: mainDraft },
        projectDraftThreadIdByProjectId: { [projectId]: mainThreadId },
        options,
      });
      applyOwnershipLedgerToComposer(before, scope);
      useComposerDraftStore.getState().setPrompt(mainThreadId, "preserve this draft");
      const replace = () =>
        replaceCollidingDraftOwnership({
          scope,
          threadId: mainThreadId,
          status: "archived",
          serverEpoch: "server-1",
          canonicalRevision: 9,
          invalidatedAt: "2026-08-27T01:00:00.000Z",
          createThreadId: () => compactThreadId,
          options,
        });
      const result = await replace();
      expect(result.replacement).toEqual({
        ...mainDraft,
        threadId: compactThreadId,
        generation: before.nextGeneration,
      });
      expect(result.replacement.generation).toBeGreaterThan(result.previous.generation);
      const persisted = readOwnershipLedger(storage);
      expect(persisted.status).toBe("ready");
      if (persisted.status !== "ready") return;
      expect(persisted.value.scopes[scope].draftsByThreadId).toEqual({
        [compactThreadId]: result.replacement,
      });
      expect(persisted.value.scopes[scope].projectBindingsByProjectId[projectId]).toEqual({
        projectId,
        threadId: compactThreadId,
        generation: result.replacement.generation,
      });
      applyOwnershipLedgerToComposer(persisted.value, scope);
      expect(useComposerDraftStore.getState().draftsByThreadId[mainThreadId]).toBeUndefined();
      expect(useComposerDraftStore.getState().draftsByThreadId[compactThreadId]?.prompt).toBe(
        "preserve this draft",
      );
      useComposerDraftStore.getState().setPrompt(compactThreadId, "edited after replacement");
      applyOwnershipLedgerToComposer(persisted.value, scope);
      expect(useComposerDraftStore.getState().draftsByThreadId[compactThreadId]?.prompt).toBe(
        "edited after replacement",
      );
      // A repeated notification must resolve to the same durable replacement.
      expect((await replace()).replacement).toEqual(result.replacement);
    },
  );
});
