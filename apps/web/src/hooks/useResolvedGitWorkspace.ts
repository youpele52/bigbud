import type { ThreadId } from "@bigbud/contracts";

import { useResolvedWorkspace } from "./useResolvedWorkspace";

export function useResolvedGitWorkspace(activeThreadId?: ThreadId | null) {
  return useResolvedWorkspace(activeThreadId);
}
