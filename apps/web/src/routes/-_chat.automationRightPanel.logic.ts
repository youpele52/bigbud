import type { ThreadId } from "@bigbud/contracts";
import type { SidebarThreadSortOrder } from "@bigbud/contracts/settings";

import {
  resolveMostRecentThreadId,
  type SidebarThreadSortInput,
} from "~/components/sidebar/Sidebar.sort.logic";
import type { Thread } from "~/models/types";

type NavigateToThread = (input: {
  to: "/$threadId" | "/";
  params?: { threadId: ThreadId };
}) => Promise<void>;

type NavigableThread = Pick<
  Thread,
  "id" | "createdAt" | "updatedAt" | "archivedAt" | "deletingAt" | "purpose"
> &
  SidebarThreadSortInput;

export function navigateToMostRecentThread(input: {
  navigate: NavigateToThread;
  sortOrder: SidebarThreadSortOrder;
  threads: readonly NavigableThread[];
}): Promise<void> {
  const threadId = resolveMostRecentThreadId(input.threads, input.sortOrder);
  if (threadId) {
    return input.navigate({ to: "/$threadId", params: { threadId } });
  }

  return input.navigate({ to: "/" });
}
