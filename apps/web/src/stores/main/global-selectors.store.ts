import { type ThreadId } from "@bigbud/contracts";
import { useMemo } from "react";
import {
  selectIsThreadRunning,
  selectProjectById,
  selectSidebarThreadSummaryById,
  selectThreadById,
  useStore,
} from "./main.store";
import { type Project, type SidebarThreadSummary, type Thread } from "../../models/types";

export function useProjectById(projectId: Project["id"] | null | undefined): Project | undefined {
  const selector = useMemo(() => selectProjectById(projectId), [projectId]);
  return useStore(selector);
}

export function useThreadById(threadId: ThreadId | null | undefined): Thread | undefined {
  const selector = useMemo(() => selectThreadById(threadId), [threadId]);
  return useStore(selector);
}

export function useSidebarThreadSummaryById(
  threadId: ThreadId | null | undefined,
): SidebarThreadSummary | undefined {
  const selector = useMemo(() => selectSidebarThreadSummaryById(threadId), [threadId]);
  return useStore(selector);
}

/** Returns true when the thread's agent session is actively running.
 * Subscribes only to the boolean result — no re-renders for unrelated thread changes. */
export function useIsThreadRunning(threadId: ThreadId | null | undefined): boolean {
  const selector = useMemo(() => selectIsThreadRunning(threadId), [threadId]);
  return useStore(selector);
}
