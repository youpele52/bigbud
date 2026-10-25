import { THREAD_FORKED_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/orchestration.fork.ts";
import { useMemo } from "react";

import type { Thread } from "../../../models/types/app.types";
import { useStore } from "../../../stores/main";

/**
 * Which of a source's forks the store still knows. A deleted thread leaves the store, so its fork
 * no longer counts: the source links nothing and offers "Continue in a new thread" again (D20).
 */
export function useForkPresence(
  activities: Thread["activities"],
): (forkThreadId: string) => boolean {
  const forkIds = useMemo(
    () => [
      ...new Set(
        activities.flatMap((activity) => {
          if (activity.kind !== THREAD_FORKED_ACTIVITY_KIND) return [];
          const payload = activity.payload as { forkThreadId?: unknown } | null;
          return typeof payload?.forkThreadId === "string" ? [payload.forkThreadId] : [];
        }),
      ),
    ],
    [activities],
  );
  // A string key keeps the selector stable, so unrelated store updates do not re-render.
  const presentKey = useStore((state) =>
    forkIds
      .filter(
        (id) =>
          state.sidebarThreadsById[id] !== undefined ||
          state.threads.some((thread) => thread.id === id),
      )
      .join("\n"),
  );
  return useMemo(() => {
    const present = new Set(presentKey.split("\n"));
    return (forkThreadId: string) => present.has(forkThreadId);
  }, [presentKey]);
}
