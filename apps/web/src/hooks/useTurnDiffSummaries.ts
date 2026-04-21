import { useMemo } from "react";
import { inferCheckpointTurnCountByTurnId } from "../logic/session";
import type { Thread } from "../models/types";

export function useTurnDiffSummaries(activeThread: Thread | undefined) {
  const turnDiffSummaries = useMemo(() => {
    if (!activeThread) {
      return [];
    }
    return activeThread.turnDiffSummaries;
  }, [activeThread]);

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
