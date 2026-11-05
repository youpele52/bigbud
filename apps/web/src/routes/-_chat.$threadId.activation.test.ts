import {
  BUILT_IN_CHATS_PROJECT_ID,
  ProjectId,
  ThreadId,
  type ExecutionTargetId,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { Project, Thread } from "../models/types";
import {
  resolveCanonicalThreadRevealTransition,
  resolveCanonicalThreadRouteActivation,
} from "./-_chat.$threadId.activation";

const localProjectId = ProjectId.makeUnsafe("local-project");
const remoteWorkspaceId = ProjectId.makeUnsafe("remote-workspace");

function makeThread(projectId: ProjectId, overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe(`thread-${projectId}`),
    projectId,
    purpose: "standard",
    archivedAt: null,
    deletingAt: null,
    pinnedAt: null,
    ...overrides,
  } as Thread;
}

function makeProject(id: ProjectId, workspaceExecutionTargetId: ExecutionTargetId): Project {
  return { id, workspaceExecutionTargetId, deletingAt: null } as Project;
}

describe("canonical thread route activation", () => {
  it("opens Projects and the local project", () => {
    expect(
      resolveCanonicalThreadRouteActivation({
        thread: makeThread(localProjectId),
        project: makeProject(localProjectId, "local"),
        isPinned: false,
      }),
    ).toMatchObject({
      openChats: false,
      openProjects: true,
      openRemoteWorkspaces: false,
      projectId: localProjectId,
    });
  });

  it("opens Remote Workspaces using project execution scope", () => {
    expect(
      resolveCanonicalThreadRouteActivation({
        thread: makeThread(remoteWorkspaceId),
        project: makeProject(remoteWorkspaceId, "ssh:workspace"),
        isPinned: false,
      }),
    ).toMatchObject({ openProjects: false, openRemoteWorkspaces: true });
  });

  it("keeps Sidebar project scope authoritative over thread metadata", () => {
    expect(
      resolveCanonicalThreadRouteActivation({
        thread: makeThread(remoteWorkspaceId, { workspaceExecutionTargetId: "local" }),
        project: makeProject(remoteWorkspaceId, "ssh:workspace"),
        isPinned: false,
      }),
    ).toMatchObject({ openProjects: false, openRemoteWorkspaces: true });
  });

  it("falls back to thread execution scope until its project arrives", () => {
    expect(
      resolveCanonicalThreadRouteActivation({
        thread: makeThread(remoteWorkspaceId, {
          workspaceExecutionTargetId: "ssh:workspace",
        }),
        project: undefined,
        isPinned: false,
      }),
    ).toMatchObject({ openProjects: false, openRemoteWorkspaces: true });
  });

  it("opens Chats for the built-in project and Pinned for a pinned route", () => {
    expect(
      resolveCanonicalThreadRouteActivation({
        thread: makeThread(BUILT_IN_CHATS_PROJECT_ID),
        project: undefined,
        isPinned: true,
      }),
    ).toMatchObject({
      openChats: true,
      openFavourites: true,
      openProjects: false,
      openRemoteWorkspaces: false,
    });
  });

  it.each([
    makeThread(localProjectId, { purpose: "side-chat" }),
    makeThread(localProjectId, { archivedAt: "2026-08-30T00:00:00.000Z" }),
    makeThread(localProjectId, { deletingAt: "2026-08-30T00:00:00.000Z" }),
  ])("excludes a non-renderable canonical thread", (thread) => {
    expect(
      resolveCanonicalThreadRouteActivation({
        thread,
        project: makeProject(localProjectId, "local"),
        isPinned: false,
      }),
    ).toBeNull();
  });

  it("does not reveal context again for routine updates to the same routed thread", () => {
    const firstActivation = resolveCanonicalThreadRouteActivation({
      thread: makeThread(localProjectId, { title: "Initial" }),
      project: makeProject(localProjectId, "local"),
      isPinned: false,
    });
    const first = resolveCanonicalThreadRevealTransition(
      { contextKey: null, pinned: false, threadId: null },
      firstActivation,
    );
    const updatedActivation = resolveCanonicalThreadRouteActivation({
      thread: makeThread(localProjectId, { title: "Updated" }),
      project: makeProject(localProjectId, "local"),
      isPinned: false,
    });
    const updated = resolveCanonicalThreadRevealTransition(first.next, updatedActivation);

    expect(first.revealContext).toBe(true);
    expect(updated).toMatchObject({ revealContext: false, revealFavourites: false });
  });

  it("reveals once when the routed project finishes resolving", () => {
    const unresolved = resolveCanonicalThreadRouteActivation({
      thread: makeThread(localProjectId),
      project: undefined,
      isPinned: false,
    });
    const first = resolveCanonicalThreadRevealTransition(
      { contextKey: null, pinned: false, threadId: null },
      unresolved,
    );
    const resolved = resolveCanonicalThreadRouteActivation({
      thread: makeThread(localProjectId),
      project: makeProject(localProjectId, "local"),
      isPinned: false,
    });

    expect(resolveCanonicalThreadRevealTransition(first.next, resolved).revealContext).toBe(true);
  });

  it("reveals Pinned only when the current route becomes pinned", () => {
    const unpinned = resolveCanonicalThreadRouteActivation({
      thread: makeThread(localProjectId),
      project: makeProject(localProjectId, "local"),
      isPinned: false,
    });
    const first = resolveCanonicalThreadRevealTransition(
      { contextKey: null, pinned: false, threadId: null },
      unpinned,
    );
    const pinned = resolveCanonicalThreadRouteActivation({
      thread: makeThread(localProjectId),
      project: makeProject(localProjectId, "local"),
      isPinned: true,
    });

    expect(resolveCanonicalThreadRevealTransition(first.next, pinned)).toMatchObject({
      revealContext: false,
      revealFavourites: true,
    });
  });
});
