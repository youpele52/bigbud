import { ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  isThreadAlreadyExistsError,
  repairDuplicateCreateDraft,
} from "./ChatView.sendTurn.ownership";

const projectId = ProjectId.makeUnsafe("project-1");
const threadId = ThreadId.makeUnsafe("thread-poisoned");

describe("repairDuplicateCreateDraft", () => {
  it("moves a rejected bootstrap draft away from canonical ownership", async () => {
    const replaceCollision = vi.fn();
    const nextThreadId = await repairDuplicateCreateDraft({
      api: {
        orchestration: {
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            projectId,
            status: "archived" as const,
            serverEpoch: "server-1",
            canonicalRevision: 15,
          })),
        } as never,
      },
      error: { code: "thread_already_exists" },
      threadId,
      getDraft: () => ({
        threadId,
        projectId,
        createdAt: "2026-08-25T19:48:36.000Z",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
      }),
      replaceCollision,
    });

    expect(nextThreadId).not.toBeNull();
    expect(nextThreadId).not.toBe(threadId);
    expect(replaceCollision).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, nextThreadId, projectId }),
    );
  });

  it("does not clear a draft for transport or unconfirmed ownership failures", async () => {
    const replaceCollision = vi.fn();
    expect(isThreadAlreadyExistsError(new Error("offline"))).toBe(false);
    expect(
      await repairDuplicateCreateDraft({
        api: {
          orchestration: {
            resolveThreadOwnership: vi.fn(async () => ({
              threadId,
              status: "unavailable" as const,
              ownership: "unconfirmed" as const,
              reason: "offline",
            })),
          } as never,
        },
        error: { code: "thread_already_exists" },
        threadId,
        getDraft: () => null,
        replaceCollision,
      }),
    ).toBeNull();
    expect(replaceCollision).not.toHaveBeenCalled();
  });
});
