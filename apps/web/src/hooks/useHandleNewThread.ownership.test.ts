import { ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createOwnershipReplacementThreadId,
  resolveProjectDraftOwnership,
} from "./useHandleNewThread.ownership";

const projectId = ProjectId.makeUnsafe("project-1");
const threadId = ThreadId.makeUnsafe("thread-poisoned");
const nextThreadId = ThreadId.makeUnsafe("thread-fresh");
const draft = {
  threadId,
  projectId,
  createdAt: "2026-08-25T19:48:36.000Z",
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  envMode: "local" as const,
};

describe("resolveProjectDraftOwnership", () => {
  it("allocates a fresh UUID for every canonical collision repair", async () => {
    const ownership = {
      threadId,
      projectId,
      status: "archived" as const,
      serverEpoch: "server-1",
      canonicalRevision: 12,
    };

    const first = await createOwnershipReplacementThreadId(ownership);
    const second = await createOwnershipReplacementThreadId(ownership);

    expect(first).not.toBe(second);
    expect(first).not.toBe(threadId);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  });

  it("reuses only an authoritatively absent draft id", async () => {
    const replaceCollidingDraftThread = vi.fn();
    const result = await resolveProjectDraftOwnership({
      api: {
        orchestration: {
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            status: "absent" as const,
            serverEpoch: "server-1",
            canonicalRevision: 12,
            reusePolicy: "canonical-identity-unclaimed" as const,
          })),
        } as never,
      },
      draft,
      projectId,
      createThreadId: () => nextThreadId,
      now: () => "2026-08-26T20:00:00.000Z",
      replaceCollidingDraftThread,
    });

    expect(result).toEqual({ status: "reusable", threadId });
    expect(replaceCollidingDraftThread).not.toHaveBeenCalled();
  });

  it.each(["active", "archived", "deleting"] as const)(
    "replaces a %s canonical collision with a fresh id",
    async (status) => {
      const replaceCollidingDraftThread = vi.fn();
      const result = await resolveProjectDraftOwnership({
        api: {
          orchestration: {
            resolveThreadOwnership: vi.fn(async () => ({
              threadId,
              projectId,
              status,
              serverEpoch: "server-1",
              canonicalRevision: 12,
            })),
          } as never,
        },
        draft,
        projectId,
        createThreadId: () => nextThreadId,
        now: () => "2026-08-26T20:00:00.000Z",
        replaceCollidingDraftThread,
      });

      expect(result).toEqual({ status: "replaced", threadId: nextThreadId });
      expect(replaceCollidingDraftThread).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId,
          nextThreadId,
          projectId,
          createdAt: "2026-08-26T20:00:00.000Z",
        }),
      );
    },
  );

  it("replaces a deleted canonical collision despite its server reuse policy", async () => {
    const replaceCollidingDraftThread = vi.fn();
    const result = await resolveProjectDraftOwnership({
      api: {
        orchestration: {
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            projectId,
            status: "deleted" as const,
            reusePolicy: "explicit-create-after-deletion" as const,
            serverEpoch: "server-1",
            canonicalRevision: 12,
          })),
        } as never,
      },
      draft,
      projectId,
      createThreadId: () => nextThreadId,
      now: () => "2026-08-26T20:00:00.000Z",
      replaceCollidingDraftThread,
    });

    expect(result).toEqual({ status: "replaced", threadId: nextThreadId });
    expect(replaceCollidingDraftThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        nextThreadId,
        projectId,
        createdAt: "2026-08-26T20:00:00.000Z",
      }),
    );
  });

  it("keeps uncertain draft state intact while ownership is unavailable", async () => {
    const replaceCollidingDraftThread = vi.fn();
    const result = await resolveProjectDraftOwnership({
      api: {
        orchestration: {
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            status: "unavailable" as const,
            ownership: "unconfirmed" as const,
            reason: "server unavailable",
          })),
        } as never,
      },
      draft,
      projectId,
      createThreadId: () => nextThreadId,
      now: () => "2026-08-26T20:00:00.000Z",
      replaceCollidingDraftThread,
    });

    expect(result).toEqual({ status: "unavailable", reason: "server unavailable" });
    expect(replaceCollidingDraftThread).not.toHaveBeenCalled();
  });
});
