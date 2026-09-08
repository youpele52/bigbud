import { ProjectId, ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useComposerDraftStore } from "../composer";
import { resetComposerDraftStore } from "../composer/composer.store.test.utils";
import { applyOwnershipLedgerToComposer } from "./ownershipLedger.composer";
import {
  emptyOwnershipLedger,
  initializeOwnershipLedger,
  readOwnershipLedger,
  registerDraftOwnership,
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
});
