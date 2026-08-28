import { ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { repairPersistedDraftOwnership } from "./draftOwnership.repair";
import { resolveProjectDraftOwnership } from "./useHandleNewThread.ownership";
import { useComposerDraftStore } from "../stores/composer";
import { resetComposerDraftStore } from "../stores/composer/composer.store.test.utils";

const projectId = ProjectId.makeUnsafe("project-repair");
const ids = {
  active: ThreadId.makeUnsafe("thread-active"),
  archived: ThreadId.makeUnsafe("thread-archived"),
  deleted: ThreadId.makeUnsafe("thread-deleted"),
  absent: ThreadId.makeUnsafe("thread-absent"),
  unavailable: ThreadId.makeUnsafe("thread-unavailable"),
};

describe("repairPersistedDraftOwnership", () => {
  it("repairs canonical drafts while preserving absent and uncertain drafts", async () => {
    const reconcileCanonical = vi.fn();
    const replaceCollision = vi.fn();
    const replacementIds = {
      [ids.archived]: ThreadId.makeUnsafe("replacement-archived"),
      [ids.deleted]: ThreadId.makeUnsafe("replacement-deleted"),
    };
    const summary = await repairPersistedDraftOwnership({
      api: {
        orchestration: {
          resolveThreadOwnership: vi.fn(async ({ threadId }) => {
            if (threadId === ids.absent) {
              return {
                threadId,
                status: "absent" as const,
                reusePolicy: "canonical-identity-unclaimed" as const,
                serverEpoch: "server-1",
                canonicalRevision: 20,
              };
            }
            if (threadId === ids.unavailable) {
              return {
                threadId,
                status: "unavailable" as const,
                ownership: "unconfirmed" as const,
                reason: "offline",
              };
            }
            const status =
              threadId === ids.active
                ? "active"
                : threadId === ids.archived
                  ? "archived"
                  : "deleted";
            return {
              threadId,
              projectId,
              status,
              ...(status === "deleted"
                ? { reusePolicy: "explicit-create-after-deletion" as const }
                : {}),
              serverEpoch: "server-1",
              canonicalRevision: 20,
            } as never;
          }),
        } as never,
      },
      drafts: Object.values(ids).map((threadId) => ({
        threadId,
        projectId,
        createdAt: "2026-08-25T19:48:36.000Z",
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        envMode: "local" as const,
      })),
      reconcileCanonical,
      replaceCollision,
      createReplacementThreadId: async (ownership) => replacementIds[ownership.threadId]!,
    });

    expect(summary).toEqual({
      absent: 1,
      canonical: 1,
      replaced: 2,
      unavailable: 1,
      failures: [{ threadId: ids.unavailable, reason: "ownership_unavailable" }],
    });
    expect(reconcileCanonical).toHaveBeenCalledWith(ids.active);
    expect(replaceCollision).toHaveBeenCalledTimes(2);
    expect(replaceCollision).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: ids.deleted,
        nextThreadId: replacementIds[ids.deleted],
      }),
    );
  });

  it("reports sanitized request failures without clearing the uncertain draft", async () => {
    const replaceCollision = vi.fn();
    const reconcileCanonical = vi.fn();
    const summary = await repairPersistedDraftOwnership({
      api: {
        orchestration: {
          resolveThreadOwnership: vi.fn(async () => {
            throw new Error("sensitive internal transport detail");
          }),
        } as never,
      },
      drafts: [
        {
          threadId: ids.unavailable,
          projectId,
          createdAt: "2026-08-25T19:48:36.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      ],
      reconcileCanonical,
      replaceCollision,
    });

    expect(summary.failures).toEqual([{ threadId: ids.unavailable, reason: "request_failed" }]);
    expect(reconcileCanonical).not.toHaveBeenCalled();
    expect(replaceCollision).not.toHaveBeenCalled();
    expect(JSON.stringify(summary)).not.toContain("sensitive internal transport detail");
  });

  it("repairs an archived promoted draft before New Thread reuses its project mapping", async () => {
    resetComposerDraftStore();
    const replacementThreadId = ThreadId.makeUnsafe("replacement-after-restart");
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, ids.archived);
    store.setPrompt(ids.archived, "preserve after restart");

    await repairPersistedDraftOwnership({
      api: {
        orchestration: {
          resolveThreadOwnership: vi.fn(async () => ({
            threadId: ids.archived,
            projectId,
            status: "archived" as const,
            serverEpoch: "server-1",
            canonicalRevision: 20,
          })),
        } as never,
      },
      drafts: [store.getDraftThreadByProjectId(projectId)!],
      reconcileCanonical: store.reconcileCanonicalThread,
      replaceCollision: store.replaceCollidingDraftThread,
      createReplacementThreadId: async () => replacementThreadId,
    });

    const repaired = useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)!;
    expect(repaired.threadId).toBe(replacementThreadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[replacementThreadId]?.prompt).toBe(
      "preserve after restart",
    );
    expect(
      await resolveProjectDraftOwnership({
        api: {
          orchestration: {
            resolveThreadOwnership: vi.fn(async () => ({
              threadId: replacementThreadId,
              status: "absent" as const,
              reusePolicy: "canonical-identity-unclaimed" as const,
              serverEpoch: "server-1",
              canonicalRevision: 20,
            })),
          } as never,
        },
        draft: repaired,
        projectId,
        createThreadId: () => ThreadId.makeUnsafe("unused"),
        now: () => "2026-08-26T20:00:00.000Z",
        replaceCollidingDraftThread: vi.fn(),
      }),
    ).toEqual({ status: "reusable", threadId: replacementThreadId });
  });
});
