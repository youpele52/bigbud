import { isBuiltInChatsProject, isRemoteExecutionTargetId } from "@bigbud/contracts";
import { useEffect, useRef } from "react";

import { resolveWorkspaceExecutionTargetId } from "../lib/providerExecutionTargets";
import type { Project, Thread } from "../models/types";
import { useUiStateStore } from "../stores/ui";

export interface CanonicalThreadRouteActivation {
  openChats: boolean;
  openFavourites: boolean;
  openProjects: boolean;
  openRemoteProjects: boolean;
  projectId: Thread["projectId"];
  projectResolved: boolean;
  scope: "chats" | "local" | "remote";
  threadId: Thread["id"];
}

export interface CanonicalThreadRevealState {
  contextKey: string | null;
  pinned: boolean;
  threadId: Thread["id"] | null;
}

export function resolveCanonicalThreadRouteActivation(input: {
  thread: Thread | undefined;
  project: Project | undefined;
  isPinned: boolean;
}): CanonicalThreadRouteActivation | null {
  const { isPinned, project, thread } = input;
  if (
    !thread ||
    thread.purpose === "side-chat" ||
    thread.archivedAt !== null ||
    thread.deletingAt != null ||
    project?.deletingAt != null
  ) {
    return null;
  }

  const openChats = isBuiltInChatsProject(thread.projectId);
  const executionScope = project ?? thread;
  const isRemote =
    !openChats && isRemoteExecutionTargetId(resolveWorkspaceExecutionTargetId(executionScope));
  const scope = openChats ? "chats" : isRemote ? "remote" : "local";

  return {
    openChats,
    openFavourites: isPinned || thread.pinnedAt != null,
    openProjects: !openChats && !isRemote,
    openRemoteProjects: !openChats && isRemote,
    projectId: thread.projectId,
    projectResolved: project !== undefined,
    scope,
    threadId: thread.id,
  };
}

export function resolveCanonicalThreadRevealTransition(
  previous: CanonicalThreadRevealState,
  activation: CanonicalThreadRouteActivation | null,
): {
  next: CanonicalThreadRevealState;
  revealContext: boolean;
  revealFavourites: boolean;
} {
  if (!activation) {
    return {
      next: { contextKey: null, pinned: false, threadId: null },
      revealContext: false,
      revealFavourites: false,
    };
  }
  const contextKey = `${activation.threadId}:${activation.projectId}:${activation.scope}:${activation.projectResolved}`;
  return {
    next: {
      contextKey,
      pinned: activation.openFavourites,
      threadId: activation.threadId,
    },
    revealContext: previous.contextKey !== contextKey,
    revealFavourites:
      activation.openFavourites && (previous.threadId !== activation.threadId || !previous.pinned),
  };
}

export function useCanonicalThreadRouteActivation(input: {
  thread: Thread | undefined;
  project: Project | undefined;
  isPinned: boolean;
}): void {
  const { isPinned, project, thread } = input;
  const activation = resolveCanonicalThreadRouteActivation({ isPinned, project, thread });
  const threadId = activation?.threadId ?? null;
  const projectId = activation?.projectId ?? null;
  const projectResolved = activation?.projectResolved ?? false;
  const scope = activation?.scope ?? null;
  const pinned = activation?.openFavourites ?? false;
  const revealStateRef = useRef<CanonicalThreadRevealState>({
    contextKey: null,
    pinned: false,
    threadId: null,
  });

  useEffect(() => {
    if (threadId) useUiStateStore.getState().setLastActiveThreadId(threadId);
  }, [threadId]);

  useEffect(() => {
    const currentActivation: CanonicalThreadRouteActivation | null =
      threadId && projectId && scope
        ? {
            openChats: scope === "chats",
            openFavourites: pinned,
            openProjects: scope === "local",
            openRemoteProjects: scope === "remote",
            projectId,
            projectResolved,
            scope,
            threadId,
          }
        : null;
    const transition = resolveCanonicalThreadRevealTransition(
      revealStateRef.current,
      currentActivation,
    );
    revealStateRef.current = transition.next;
    if (!currentActivation) return;
    const ui = useUiStateStore.getState();
    if (transition.revealFavourites) ui.setFavouritesExpanded(true);
    if (!transition.revealContext) return;
    if (currentActivation.openChats) ui.setChatsExpanded(true);
    if (currentActivation.openProjects) ui.setProjectsExpanded(true);
    if (currentActivation.openRemoteProjects) ui.setRemoteProjectsExpanded(true);
    if (!currentActivation.openChats) {
      ui.setProjectExpanded(currentActivation.projectId, true);
      ui.setSelectedProject(currentActivation.projectId);
    }
  }, [pinned, projectId, projectResolved, scope, threadId]);
}
