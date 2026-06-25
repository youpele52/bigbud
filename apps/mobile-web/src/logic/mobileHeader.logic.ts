import {
  BUILT_IN_CHATS_PROJECT_TITLE,
  type OrchestrationReadModel,
  type ProjectId,
  type ThreadId,
  isBuiltInChatsProject,
} from "@bigbud/contracts";
import { DEFAULT_THREAD_TITLE } from "@bigbud/shared/String";

import type { MobileDraftThread } from "../lib/mobileDraftThread";

export interface MobileHeaderBreadcrumbSegment {
  readonly label: string;
  readonly to?: string | undefined;
}

export interface MobileHeaderState {
  readonly showLogo: boolean;
  readonly showBack: boolean;
  readonly title?: string | undefined;
  readonly backTo: string;
  readonly breadcrumb?: ReadonlyArray<MobileHeaderBreadcrumbSegment> | undefined;
}

const MOBILE_THREAD_PATH_PATTERN = /^\/mobile\/thread\/([^/]+)(?:\/|$)/;
const MOBILE_PROJECT_THREADS_PATH_PATTERN = /^\/mobile\/projects\/([^/]+)$/;

export function extractMobileThreadId(pathname: string): ThreadId | null {
  const match = pathname.match(MOBILE_THREAD_PATH_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  return match[1] as ThreadId;
}

export function extractMobileProjectId(pathname: string): ProjectId | null {
  const match = pathname.match(MOBILE_PROJECT_THREADS_PATH_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  return match[1] as ProjectId;
}

export function isMobileLaunchRoute(pathname: string): boolean {
  return pathname === "/" || pathname === "/mobile";
}

export function resolveMobileHeaderState(
  pathname: string,
  snapshot: OrchestrationReadModel | undefined,
  draftThread: MobileDraftThread | null,
): MobileHeaderState {
  if (pathname === "/" || pathname === "/mobile") {
    return { showLogo: true, showBack: false, title: undefined, backTo: "/mobile" };
  }
  if (pathname === "/mobile/projects") {
    return { showLogo: false, showBack: true, title: "Projects", backTo: "/mobile" };
  }
  if (pathname.startsWith("/mobile/projects/")) {
    const projectId = extractMobileProjectId(pathname);
    const project = projectId
      ? snapshot?.projects.find((candidate) => candidate.id === projectId)
      : undefined;
    return {
      showLogo: false,
      showBack: true,
      title: project?.title ?? "Project",
      backTo: "/mobile/projects",
    };
  }
  if (pathname === "/mobile/chats") {
    return { showLogo: false, showBack: true, title: "Recents", backTo: "/mobile" };
  }

  const threadId = extractMobileThreadId(pathname);
  if (threadId && !pathname.endsWith("/diff")) {
    const thread = snapshot?.threads.find((candidate) => candidate.id === threadId) ?? null;
    const projectId = thread?.projectId ?? draftThread?.projectId;
    const project = projectId
      ? snapshot?.projects.find((candidate) => candidate.id === projectId)
      : undefined;
    const isChatsThread = projectId ? isBuiltInChatsProject(projectId) : false;
    const parentLabel = isChatsThread
      ? BUILT_IN_CHATS_PROJECT_TITLE
      : (project?.title ?? "Project");
    const parentTo = isChatsThread
      ? "/mobile/chats"
      : project
        ? `/mobile/projects/${project.id}`
        : "/mobile/chats";
    const threadTitle = thread?.title ?? DEFAULT_THREAD_TITLE;

    return {
      showLogo: false,
      showBack: true,
      backTo: parentTo,
      breadcrumb: [{ label: parentLabel, to: parentTo }, { label: threadTitle }],
    };
  }

  return { showLogo: false, showBack: false, title: undefined, backTo: "/mobile" };
}
